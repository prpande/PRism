# Architectural readiness

Cross-cutting structural work surfaced by a spec/backlog vs. current-code review (May 2026). Each item is gated to the slice or milestone it must land before. The roadmap holds the punch-list table and links here for depth.

This document does **not** replace per-slice spec docs. Slice-gated items here are captured as ADRs — *what*, *why*, *when*, *non-decisions* — so the rationale survives until the slice that depends on them starts. The implementation design for each slice-gated item is brainstormed at slice time against the actual code as it exists then.

## Why this exists

A May 2026 review of the PoC implementation against `docs/spec/` and `docs/backlog/` surfaced cross-cutting structural work that doesn't fit any single slice's *Scope* cell:

- **Now-gated items** are independent of any in-flight slice and are next in queue.
- **Slice-gated items** must land before a specific upcoming slice (S4, S5, P0+ kickoff) for that slice to land cleanly.
- **A convention** is captured for how state machines should be organized when they start landing.

The architectural shape of the project — vertical / feature-sliced, project-per-external-dependency, capability-flag-gated AI seams — is **not** under review. The shape is the right shape for the future the backlog describes. This document tightens the seams within that shape; it does not rearrange them.

## Gating taxonomy

- **Now** — not blocked by any slice. Land in the order specified (each PR depends only on the prior one being merged or trivially rebaseable).
- **Before S4 (drafts)** — S4 is the first slice where state mutations originate inside the app. Fixing state-shape concerns under the slice that introduces the heaviest writes is much cheaper than retrofitting later.
- **Before S5 (submit)** — S5 adds the GraphQL pending-review pipeline with a resumable retry state machine. The pre-work makes S5's tests tractable.
- **Before P0+ (v2 begins)** — P0+ introduces multiple new projects, async-init paths, and the AI seam proliferation. Pre-decisions here prevent precedent-by-accident.

## Now — full design

### PR 1: Banned-API analyzer for Octokit

**Goal.** Turn the spec invariant *"no `using Octokit;` in `PRism.Core` / `PRism.Web`"* (`docs/spec/02-architecture.md` § "Dependency rule") from convention-enforced-by-review into compile-time-enforced-by-CI. Extend the rule to all `PRism.AI.*` projects.

**Tooling.** `Microsoft.CodeAnalysis.BannedApiAnalyzers` (NuGet, maintained by `dotnet/roslyn-analyzers`). Standard, no custom Roslyn code.

**Banned symbols** — single shared file `BannedSymbols.txt` at the repo root:

```
N:Octokit;Octokit namespace is banned in this project per spec/02-architecture.md § Dependency rule. Use IReviewService and the PRism.GitHub adapter.
```

`N:Octokit` bans the namespace and all sub-namespaces; any `Octokit.*` type triggers `RS0030`.

**Wiring** — `Directory.Build.props` adds the analyzer + banned-symbols file conditionally on an MSBuild property `<BanOctokit>true</BanOctokit>` (default true). `PRism.GitHub.csproj` and `PRism.GitHub.Tests.csproj` opt out by setting `<BanOctokit>false</BanOctokit>`. The `PackageReference` must specify `IncludeAssets="analyzers; build; buildtransitive"` explicitly when added via `Directory.Build.props` under Central Package Management — without it the analyzer DLL is referenced but never handed to the compiler's `Analyzer` list (verified during PR #10 — `dotnet msbuild -t:_GetCompilerArguments -v:diag` shows the difference). The version pin is `Microsoft.CodeAnalysis.BannedApiAnalyzers` 4.14.0; an older 3.3.x line was tested first and loaded the analyzer but appeared to silently no-op symbol matching on the .NET 10 toolchain in this repo.

**Project scope:**

| Project | `BanOctokit` |
|---|---|
| `PRism.Core` | true |
| `PRism.Core.Contracts` | true |
| `PRism.Web` | true |
| `PRism.AI.Contracts` | true |
| `PRism.AI.Placeholder` | true |
| `PRism.GitHub` | **false** (legitimately uses Octokit) |
| `tests/PRism.Core.Tests` | true |
| `tests/PRism.Web.Tests` | true |
| `tests/PRism.GitHub.Tests` | **false** (tests the Octokit adapter) |

**TDD framing — intentional deviation, documented:** This task adds a *build-time check*, not runtime behavior. CLAUDE.md's TDD rule says "if a test wasn't written first, the behavior wasn't actually built." The behavior is *build fails when Octokit is referenced from a banned project*; the test is *introducing a violation produces the failure*.

A traditional unit test using `Microsoft.CodeAnalysis.CSharp.Analyzer.Testing` would compile a synthetic snippet with `using Octokit;` and assert RS0030 fires — but that retests upstream's analyzer, not our wiring. The wiring is what matters: *is the analyzer applied to `PRism.Core`'s csproj with the right banned list?*

**The TDD discipline used here is an acceptance test executed at PR time, with the proof captured in the PR description:**

1. **Red.** Add `using Octokit;` to a file in `PRism.Core` (any file). Run `dotnet build`. Capture the output, which must contain `error RS0030: Symbol 'Octokit' is banned`.
2. **Green.** Revert. Run `dotnet build`. Output must be clean.
3. **Document.** Paste the red-output and clean-output into the PR description as the proof-of-behavior.

This is a literal red→green cycle done at PR scope, not suite scope. It is an intentional exception to the "permanent test in the suite" pattern. The spec records it explicitly so it isn't mistaken for slop.

**Files touched:**
- `Directory.Packages.props` — pin `Microsoft.CodeAnalysis.BannedApiAnalyzers`.
- `Directory.Build.props` — add the conditional analyzer + AdditionalFiles wiring.
- `BannedSymbols.txt` — new shared file at repo root.
- `PRism.GitHub.csproj`, `tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj` — opt out via `<BanOctokit>false</BanOctokit>`.

**Acceptance criteria:**
1. `dotnet build` (full solution) passes with no new diagnostics on the current code.
2. Adding `using Octokit;` to any banned project produces `error RS0030` and fails the build.
3. `PRism.GitHub` and `PRism.GitHub.Tests` build remain unaffected.
4. PR description includes the captured red and green build output as proof.

**Recipe for future banned-API rules** (e.g., banning `System.Diagnostics.Process.Start` from `PRism.Web`): add the symbol to `BannedSymbols.txt`, decide which projects need to opt out, set `<Ban*>false</Ban*>` MSBuild properties on those, run the same red→green proof.

---

### PR 2: DI extension methods per project

**Goal.** Decompose the ~150 lines of DI registration in `PRism.Web/Program.cs` into per-project `AddPrism*()` extension methods. Make `Program.cs` a one-page manifest of what the host is composed of.

**Final shape of Program.cs (target):**

```csharp
var builder = WebApplication.CreateBuilder(args);
var dataDir = builder.Configuration["DataDir"] ?? DataDirectoryResolver.Resolve();

builder.Services.AddPrismCore(dataDir);
builder.Services.AddPrismGitHub();
builder.Services.AddPrismAi();
builder.Services.AddPrismWeb();

var app = builder.Build();
// ... lockfile, port selection, browser launch (host-shaped, stay in Program.cs)
// ... middleware pipeline + endpoint mappings (stay in Program.cs)
app.Run();
```

Estimated `Program.cs` LoC after: ≤ 110, down from 282.

**Files added:**

| Project | New file | Owns |
|---|---|---|
| `PRism.Core` | `ServiceCollectionExtensions.cs` | `AddPrismCore(IServiceCollection, string dataDir)` — `IConfigStore` (with the existing `[SuppressMessage]` pragma preserved verbatim), `AiPreviewState`, `IAppStateStore`, `ITokenStore`, `IViewerLoginProvider`, `IReviewEventBus`, `InboxSubscriberCount`, `IInboxDeduplicator`, `IInboxRefreshOrchestrator`, `ViewerLoginHydrator` (hosted), `InboxPoller` (hosted) |
| `PRism.GitHub` | `ServiceCollectionExtensions.cs` | `AddPrismGitHub()` — named `github` `HttpClient`, `IReviewService` factory, the four `PRism.GitHub/Inbox/` impls (`ICiFailingDetector`, `ISectionQueryRunner`, `IPrEnricher`, `IAwaitingAuthorFilter`) |
| `PRism.AI.Contracts` | `ServiceCollectionExtensions.cs` | `AddNoopSeams()` — 9 Noop singletons |
| `PRism.AI.Placeholder` | `ServiceCollectionExtensions.cs` | `AddPlaceholderSeams()` — 9 Placeholder singletons |
| `PRism.Web` | `Composition/ServiceCollectionExtensions.cs` | `AddPrismAi()` (calls `AddNoopSeams` + `AddPlaceholderSeams` + registers `IAiSeamSelector` with both dicts), `AddPrismWeb()` (`SseChannel`, `ConfigureHttpJsonOptions`, `AddProblemDetails`) |

Every `AddPrism*` returns `IServiceCollection` for chaining (standard pattern).

**The "AddPrismAi belongs in Web" carve-out** — explicit, recorded so it isn't read as an oversight:

The principle "each project owns its own `AddPrism*`" applies cleanly when a project has one canonical impl set (`AddPrismCore`, `AddPrismGitHub`). For AI, two parallel impl sets (Noop and Placeholder) are selected at runtime by `ui.aiPreview`. The *registration* of each set lives with its impl project (`AddNoopSeams` in Contracts, `AddPlaceholderSeams` in Placeholder). The *composition* — calling both registrations and wiring the selector — lives in Web because the flag is a Web concern, the selector resolves at request-time inside Web, and the choice is environment-shaped, not contract-shaped.

**Service ordering invariant preserved:** `Program.cs` registers `ViewerLoginHydrator` (hosted) *before* `InboxPoller` (hosted) because `IHostedService.StartAsync` runs in registration order, and the poller needs the viewer-login cache hydrated. The same ordering must hold inside `AddPrismCore`. A code comment carries the invariant forward.

**Scope discipline (what this PR is NOT):**

- Does **not** replace the `ConfigStore` `GetAwaiter().GetResult()` pragma. That's a separate item (ADR-P0-3). The `[SuppressMessage]` and the sync-over-async pattern move into `AddPrismCore` unchanged.
- Does **not** change service lifetimes or registration order.
- Does **not** introduce options patterns (`AddPrismCore(opts => ...)`). Single positional `dataDir` parameter only.

**TDD approach — proper refactor discipline (CLAUDE.md):**

> *Refactors that don't change behavior do not require new tests — the existing suite is the safety net. If the existing suite doesn't cover the area being refactored, write the tests first (red against current behavior, green confirming current behavior), then refactor.*

Implementation steps:

1. **Audit existing test coverage.** Run all `PRism.*.Tests` suites to confirm a green baseline. The `WebApplicationFactory<Program>` integration tests in `PRism.Web.Tests` cover "host boots with all services registered" implicitly. Verify whether `IAiSeamSelector` toggle (Noop vs Placeholder by `ui.aiPreview` flag) is covered by a test. **If not, write that test first** — red against current Program.cs (red because the test doesn't exist), green confirming current behavior (the toggle works). Commit pre-refactor.
2. **Refactor.** Extract the extension methods. Update `Program.cs` to call them. All existing tests stay green.
3. **Verify.** `Program.cs` LoC drops to ≤ 110; no test changes needed beyond step 1.

**Acceptance criteria:**
1. `Program.cs` LoC ≤ 110.
2. All existing tests pass (plus the AI-toggle test if it had to be written in step 1).
3. Diff is mostly *moved* lines (high `git diff -M` rename detection), low *added* lines.

---

### PR 3: Named records replacing anonymous wire types

**Goal.** Replace every `Results.Ok(new { … })` / `Results.BadRequest(new { … })` / `Results.Conflict(new { … })` in `PRism.Web/Endpoints/*.cs` with strongly-typed records. Match the existing `InboxDtos.cs` precedent. Make the API surface inspectable from outside route closures.

This is the riskiest of the three PRs because it's the only one that *touches wire shapes*. Discipline matters.

**Sweep first** — enumerate every anonymous wire shape:

```bash
grep -nE "Results\.(Ok|BadRequest|Conflict|NotFound|Problem)\([[:space:]]*new \{" PRism.Web/Endpoints/*.cs
```

(Use POSIX `[[:space:]]*` rather than `\s*` — `-E` / ERE on macOS BSD `grep` does not interpret `\s`, and would silently match a literal `s` and miss every shape.)

Plus locals (`var resp = new { … }; return Results.Ok(resp);`). The output of the sweep is the work list — every match becomes a named record.

**Naming convention** (matches `InboxDtos.cs`):

- One DTO file per endpoint group, sibling to the endpoint file: `AuthDtos.cs` next to `AuthEndpoints.cs`, etc.
- One record per *distinct response shape*, not per endpoint. If `/api/auth/connect` can return three different shapes (success / error / warning), that's three records.
- Record names describe semantic role (`AuthConnectSuccess`, `AuthConnectError`, `AuthConnectWithWarning`), not endpoint path or version.

**Discriminated-union choice (resolved):** multiple records, route picks at runtime via `Results.Ok(success)` vs `Results.Ok(error)`. This preserves the current wire shape byte-identically; the frontend already handles the variation today.

**Scope discipline (what this PR is NOT):**

- Does **not** convert request-side parsing (`JsonDocument.ParseAsync` → `[FromBody]`). The current code has bespoke `invalid-json` / `pat-required` / `resolution must be …` error envelopes the frontend depends on. Switching to `[FromBody]` changes ASP.NET Core's default error envelope. Out of scope.
- Does **not** introduce frontend codegen (NSwag). Separate gated item (ADR-P0-1). PR 3 *will* update `frontend/src/types/api.ts` by hand for any drift the records expose, but it doesn't introduce the codegen pipeline.

**TDD approach — golden-file snapshot tests, written first:**

This is the only PR of the three where TDD produces a permanent suite test. The behavior preserved is *the JSON wire shape*.

1. **Pre-refactor (red→green for golden snapshots).** For every route × response code in the sweep, write an integration test (using `WebApplicationFactory<Program>`) that hits the route, captures the JSON response body, and asserts a canonicalized-JSON match against a checked-in `.golden.json` fixture. The fixtures are *generated against current code* (anonymous types) and committed. Run → green. Commit pre-refactor tests + fixtures together.
2. **Refactor.** Introduce named records, replace `new { … }` with `new RecordName(…)`. Run → tests must pass byte-identically (after canonicalization).
3. **Verify.** All golden tests pass; sweep returns zero matches in production code.

**Comparison shape — canonicalized JSON, not byte-equality.** Sort object keys recursively, normalize whitespace, then compare strings. Two reasons:
- Incidental property-order changes during future maintenance shouldn't break wire-shape tests.
- The wire contract is the *shape*, not the byte stream.

**Confirmed prerequisite (verified during gathering):** `PRism.Core/Json/JsonSerializerOptionsFactory.Api` already sets `PropertyNamingPolicy = JsonNamingPolicy.CamelCase` and `Program.cs` plumbs that into `ConfigureHttpJsonOptions`. Records with PascalCase property names will serialize to camelCase wire automatically. **No JSON-policy work needed before PR 3.**

**Gotchas — load-bearing:**

- **Reserved-word property names.** `mismatch = new { old = ..., @new = ... }` (in `/api/auth/state`) becomes `record HostMismatch(string Old, string New)` with `[JsonPropertyName("new")]` on the `New` property to preserve the wire form.
- **Nested anonymous types** (the `hostMismatch` example) need their own nested record.
- **`Results.Problem` calls** use ASP.NET Core's `ProblemDetails` shape. Already typed. Sweep should distinguish; those don't need new records.
- **`null` fields and wire consistency.** `Results.Ok(new { ok = false, error = errorName, detail = result.ErrorDetail })` — `detail` is sometimes null. **Anonymous types in `System.Text.Json` do *not* omit null properties** — they serialize as explicit `"detail": null`. Records do the same by default. Both shapes are wire-identical out of the box. If you decide null keys should be omitted instead, that is a deliberate wire-format change: add `[JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]` per property (or set `DefaultIgnoreCondition` on the options). **Before deciding either way:** verify the current wire shape by hitting the endpoint and inspecting the response, and confirm the frontend handles whichever variant you choose.
- **Frontend types drift check.** After records land, walk `frontend/src/types/api.ts` against the new records. Document any drift in PR description; fix by hand.

**Files touched:**
- New: one `*Dtos.cs` per endpoint group with anonymous shapes (estimate 4-5 new files).
- Modified: each endpoint file, replacing inline `new { … }` with `new RecordName(…)`.
- New: `PRism.Web.Tests` golden-file fixtures + tests (one test class per endpoint group).
- Possibly modified: `frontend/src/types/api.ts` for any drift.

**Acceptance criteria:**
1. The sweep `grep -nE "Results\.(Ok|BadRequest|Conflict|NotFound)\([[:space:]]*new \{" PRism.Web/Endpoints/*.cs` returns zero matches. (Excludes `Results.Problem` calls intentionally — those use ASP.NET Core's `ProblemDetails` and are already typed; see Gotchas below.)
2. Every route × response code is covered by a golden-file test.
3. All golden-file tests pass after canonicalized-JSON comparison.
4. `frontend/src/types/api.ts` reviewed; PR description notes any drift.
5. No request-side JSON-parsing semantics changed (untouched).

## Before S4 — ADR entries

### ADR-S4-1: Decompose `AppState` into typed sub-records

- **What.** Replace the flat `AppState` record with `AppState { InboxState Inbox; PrSessionsState Reviews; AiState Ai; }` (placeholder `AiState` pre-allocated for P0+). Each sub-state owns its own migration.
- **Why.** `state.json` grows linearly with features. Without sub-domain organization, by P0+ it becomes a 30+ property record carrying inbox bookkeeping, per-session draft state, idempotency keys (`pendingReviewId`, per-thread `threadId`, per-reply `replyCommentId`), AI session state (`aiState.repoCloneMap`, `aiState.chatSessions[]`, `aiState.alwaysAllowRepoAccess`), token-usage counters, etc. The spec's promised migration policy (`docs/spec/02-architecture.md` § "Schema migration policy") attaches to the top-level shape; sub-records let migration policies attach per-domain.
- **When.** Before S4 (drafts) starts. S4 is the first slice where state mutations originate inside the app — fixing the shape under the slice that introduces the heaviest writes is much cheaper than retrofitting later.
- **Non-decisions.** The exact field assignment to each sub-record. Done at slice time against actual code.
- **Pointers.** `docs/spec/02-architecture.md` § "State schema (PoC)"; `PRism.Core/State/AppState.cs`.

### ADR-S4-2: Schema-versioned migration support in `AppStateStore`

- **What.** `AppStateStore` gets explicit schema version + migration step chain. The `UnsupportedStateVersionException` already exists; the migration framework around it does not.
- **Why.** `docs/spec/02-architecture.md` § "Schema migration policy" calls for it. S5's submit-pipeline retry stamps GraphQL Node IDs into state mid-flight; loss of those IDs after a process restart due to a missed migration is a real failure mode that reads as "lost reviewer work."
- **When.** Before S4. S4 is the first slice that materially evolves `state.json`'s shape; landing migration support here lets every subsequent slice's state changes ride a known migration path.
- **Non-decisions.** Migration step shape (function vs. visitor vs. pipeline of steps). Picked at slice time.
- **Pointers.** `PRism.Core/State/UnsupportedStateVersionException.cs`; `PRism.Core/State/AppStateStore.cs`.

## Before S5 — ADR entries

### ADR-S5-1: Split `IReviewService` into capability sub-interfaces

- **What.** Split `IReviewService` (10 methods today) into:
  - `IReviewAuth` → `ValidateCredentialsAsync`
  - `IPrDiscovery` → `GetInboxAsync`, `TryParsePrUrl`
  - `IPrReader` → `GetPrAsync`, `GetIterationsAsync`, `GetDiffAsync`, `GetCommentsAsync`, `GetFileContentAsync`
  - `IReviewSubmitter` → `SubmitReviewAsync` (+ S5's new methods)

  Implementations may all stay on `GitHubReviewService` (or its partial classes) — only the interface fan-out changes.
- **Why.** S5 adds 3-5 methods to the submit pipeline (GraphQL pending-review retry, idempotency-keyed thread/reply stamping, head-moved detection, lost-response marker), pushing `GitHubReviewService.cs` from 205 LoC to ~600. Splitting before S5 lands lets S5's tests fake `IReviewSubmitter` alone instead of the full 10-method interface — and exercises ISP.
- **When.** Before S5 starts. Ideally as the first step within S5's brainstorming.
- **Non-decisions.** Whether implementations split into separate classes or stay as partial classes (orthogonal — see ADR-S5-2).
- **Pointers.** `docs/spec/02-architecture.md` § "The `IReviewService` interface"; `PRism.Core/IReviewService.cs`; `PRism.GitHub/GitHubReviewService.cs`.

### ADR-S5-2: Partial-class split of `GitHubReviewService` (optional)

- **What.** Split `GitHubReviewService.cs` into partial classes by capability area: `.Auth.cs`, `.Discovery.cs`, `.Detail.cs`, `.Submit.cs`.
- **Why.** One large file is a merge magnet. Partial classes keep the type identity and DI registration intact while localizing edits.
- **When.** Before or during S5; not load-bearing on its own.
- **Non-decisions.** Whether to do it at all — could stay one file if S5 lands cleanly without it.
- **Pointers.** `PRism.GitHub/GitHubReviewService.cs`.

## Before P0+ — ADR entries

### ADR-P0-1: Frontend types codegen for `frontend/src/types/api.ts`

- **What.** Replace the hand-mirrored `frontend/src/types/api.ts` with codegen from `PRism.Web`'s OpenAPI metadata. Tool candidates: NSwag, `Microsoft.Extensions.ApiDescription.Server` + `openapi-typescript`, or equivalent.
- **Why.** P0+P1+P2 introduces ~14 AI features, each with new wire shapes. Hand-mirroring scales linearly with PR velocity and silently drifts. The spec already acknowledges codegen as the eventual swap (`docs/spec/02-architecture.md` § "API contract").
- **When.** Before P0+ starts, OR triggered earlier by the first frontend-drift bug in production — whichever comes first.
- **Non-decisions.** Tool choice. Picked at implementation time.
- **Pointers.** `docs/spec/02-architecture.md` § "API contract"; `frontend/src/types/api.ts`; PR 3 (named records — prerequisite for codegen since OpenAPI needs named types).

### ADR-P0-2: Homes for new projects

Decide and document where each P0+ project lands *before* its first implementation lands. First implementation sets the precedent; without explicit decisions, the precedent forms by accident.

| Future component | Home | Rationale |
|---|---|---|
| LLM provider (P0-1) | `PRism.Llm.ClaudeCode` | Per spec. Naming parallels future `PRism.Llm.Anthropic`, `PRism.Llm.Ollama`. |
| AI cache (P0-2) | `PRism.AI.Contracts` (interface + helpers) or merge into `PRism.Core` if small | Avoid project sprawl. Cache is provider-agnostic. |
| Git clone service (P0-4) | **`PRism.Git.Clone`** (new) | Cloning is git, not GitHub. Does NOT belong in `PRism.GitHub`. |
| Prompt-injection sanitizer (P0-5) | `PRism.AI.Contracts` (static helpers) | Cross-cutting policy applied at prompt construction. Don't make every `PRism.AI.X` re-implement it. |
| Token usage tracker (P0-6) | `PRism.AI.Contracts` (interface) + `PRism.Llm.ClaudeCode` (impl) | Tracker is provider-agnostic; the count source is provider-specific. |
| MCP host (P0-7) | **`PRism.Mcp.Host`** (new, per spec) | Distinct subsystem with its own auth boundary, config-writing, tool dispatch. |
| Chat orchestration (P2-2) | **`PRism.AI.Chat`** (new) | WebSocket + stream-json + MCP + lazy clone + resume + state-1↔state-2 machine. Too big for `PRism.Web`. |

- **When.** Before any P0+ project's first implementation PR opens.
- **Non-decisions.** Implementation details inside each project.
- **Pointers.** `docs/backlog/01-P0-foundations.md`; `docs/backlog/02-P1-core-ai.md`; `docs/backlog/03-P2-extended-ai.md`.

### ADR-P0-3: `IHostedService` for `ConfigStore` async init

- **What.** Replace the `GetAwaiter().GetResult()` in `Program.cs`'s `CreateConfigStore` factory (and its accompanying `[SuppressMessage("Performance", "CA1849")]`) with a `ConfigStoreInitializer : IHostedService` that runs `ConfigStore.InitAsync` at host startup.
- **Why.** Removes a sync-over-async pragma. By P0+ there are 3+ async-init-needed services (Claude Code CLI version probe, AI cache file index, MCP server bind). Each new init path that follows the current pattern accumulates more pragmas. Fix the precedent now.
- **When.** Before P0+ adds another sync-over-async path. Out of scope of PR 2 by design — PR 2 is a pure DI-extraction refactor and the pragma moves into `AddPrismCore` unchanged. Replacement is a separate change with its own behavior surface (service lifetime, init ordering).
- **Non-decisions.** Whether `IHostedService` or another startup hook (e.g., `IStartupFilter`) is the right shape. Pick at implementation time.
- **Pointers.** `PRism.Web/Program.cs` (`CreateConfigStore`); `PRism.Core/Config/ConfigStore.cs`.

## Convention to adopt

### Convention-1: State machines live in `<Feature>/Pipeline/` sub-folders

- **What.** Each significant state machine — S4 stale-draft reconciliation (the seven-row matrix per `docs/spec/03-poc-features.md` § 5), S5 submit-pipeline retry, P2-2 chat state-1↔state-2 with fresh-session injection — lives in its own `<Feature>/Pipeline/` sub-folder containing one entry-point class plus a state-transition test fixture. The orchestrator class for the feature delegates to the state machine; it does not embed the transition logic. (`Pipeline/` is chosen over `StateMachine/` because it is more general — state machines, transition tables, and the surrounding orchestration can all live there without the folder name overfitting to "state machine".)
- **Why.** State machines grow tendrils. Without a fixed home, they melt into the surrounding orchestrator and become indistinguishable from the orchestration code. A fixed convention localizes the complexity and makes the transition table the unit-under-test instead of the orchestrator.
- **When.** Adopt before the first state machine lands (S4 stale-draft reconciliation). The convention does not require any retroactive refactor of existing code.
- **Pointers.** `docs/spec/03-poc-features.md` § 5 (stale-draft reconciliation); `docs/spec/03-poc-features.md` § 6 (submit pipeline retry); `docs/backlog/03-P2-extended-ai.md` § P2-2 (chat sessions).

## Out of scope for this document

The architectural shape itself — vertical / feature-sliced, project-per-external-dependency, capability-flag-gated AI seams — is **not** under review. The shape was deliberately chosen and adversarially reviewed (see `docs/spec/02-architecture.md`); this document tightens seams within it. Discussions of layered-vs-vertical, `IReviewProvider` multi-provider abstractions, or wholesale project reorganization belong in spec amendments, not here.
