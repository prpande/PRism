# S6 PR0 — Multi-account storage-shape scaffold (v1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape the irreversible-if-deferred bits — `state.json`, `config.json`, the token cache — into the multi-account shape v2 will inherit, while keeping every interface, wire payload, and v1 user-visible behavior byte-identical.

**Architecture:** One PR (one phase). The reshape is foundational but narrow: the `AppState` record gains an `ImmutableDictionary<string, AccountState> Accounts` field with delegate read properties + `WithDefault*` write helpers that preserve the existing `state.Reviews` / `state.AiState` / `state.LastConfiguredGithubHost` call sites at read time and replace `state with { Reviews = ... }` patterns at write time. A new `MigrateV4ToV5` step moves the three migrated fields under `accounts.default`. `GithubConfig` gains an `Accounts` list with `GithubAccountConfig` entries; `Host` and `LocalWorkspace` become delegate properties off `Accounts[0]`. The token cache is rewrapped from a single PAT string into `{"version": 1, "tokens": {"default": "<pat>"}}` with a version-discriminator load path.

**Tech Stack:** .NET 10 + ASP.NET Core minimal APIs + xUnit + FluentAssertions + `WebApplicationFactory`; `System.Text.Json` with the existing `JsonSerializerOptionsFactory.Storage` (kebab-case naming policy); `Microsoft.Identity.Client.Extensions.Msal` for the token cache file wrapping. No new dependencies.

**Spec:** [`docs/specs/2026-05-10-multi-account-scaffold-design.md`](../specs/2026-05-10-multi-account-scaffold-design.md) is the authoritative reference. Every task here cites the relevant spec section. Plan-time decisions and deviations from the spec — including the V3→V4 vs V4→V5 version-bump correction — are captured in the deferrals sidecar: [`docs/specs/2026-05-10-multi-account-scaffold-deferrals.md`](../specs/2026-05-10-multi-account-scaffold-deferrals.md).

---

## How to use this plan

- **One phase = one PR.** Land this slice as a single reviewable PR titled `feat(s6-pr0): multi-account storage-shape scaffold`. Storage-only scope means no follow-up sub-PRs.
- **Every test is written red first.** Run the test, watch it fail with the expected error, then write the minimal code to make it green. The TDD discipline from `.ai/docs/development-process.md` is non-negotiable. The big-bang reshape in Task 3 is the one exception — the reshape itself doesn't fit a strict red-green cycle because the constructor change is atomic across the solution; the *outcome* is that every existing test compiles and stays green via the delegate properties.
- **Use a worktree.** Per the user's standing rule (`~/src/config/claude/CLAUDE.md` "Git Worktrees"), create `.claude/worktrees/feat-s6-pr0` (separate from this plan's worktree). Implementation never lands on `main`.
- **Pre-push checklist is mandatory.** Per `~/src/config/claude/CLAUDE.md` "feedback_run_full_pre_push_checklist": run every step in `.ai/docs/development-process.md` verbatim — `npm run lint` and `npm run build` in `frontend/` are not optional even for backend-only PRs (TypeScript types may shift if SSE payloads were touched; this slice doesn't, but verify). `dotnet build` + `dotnet test` for the whole solution. One foreground sequence, never `run_in_background`. Timeout ≥ 300000ms.
- **No silent deviations from the spec.** Per `~/src/config/claude/CLAUDE.md` "feedback_document_plan_deviations": when implementation surfaces a gap or forces a change to the spec, capture the decision in the deferrals sidecar — never silently.
- **One PR, but every task commits.** Per `.ai/docs/development-process.md`, intermediate commits inside the worktree are fine and encouraged; squash on merge if the final history would be cleaner. The fifteen commits below tell the story of the reshape.

---

## Plan-time decisions (load-bearing — see the deferrals sidecar for full reasoning)

1. **Version bump is V4 → V5, not V3 → V4.** The spec was authored 2026-05-10 before S5 PR2 landed; `MigrateV3ToV4` already exists in `AppStateStore.cs` for the `DraftComment.ThreadId` addition, and `CurrentVersion = 4` is the current schema. Every spec reference to "V3 → V4 migration" / "version 4 state" is read as V4 → V5 / version 5 in this plan. Migration test fixtures use version 4 as the *pre-migration* shape.

2. **The total `with`-expression rewrite count is 23, not 9** (corrected during ce-doc-review). The spec said 7 production sites; the original plan-time draft said 9 production sites; the corrected count is **11 production + 12 test sites = 23 total**. Two things forced the recount: (a) `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:635` and `PRism.Web/TestHooks/TestEndpoints.cs:171` are production `with`-expression sites that the spec missed; (b) the original plan's verification grep `git grep 'new AppState('` returns **zero** matches because nothing in the codebase calls the constructor directly — every construction goes through `AppState.Default with { ... }`, and *every* such `with`-expression touching the migrated fields breaks after Task 3's reshape (init-only properties on the original record become read-only delegate properties on the new record, which the C# compiler rejects with `CS8852`). The correct grep is `git grep -nE 'with \{ *(Reviews|AiState|LastConfiguredGithubHost) *='`; the actual hit list (verified against `main` at HEAD `4c6ed08`) is enumerated in Task 3 steps 4 + 5 below.

3. **Spec § 11 open question resolved — delegate properties stay public, no `[Obsolete]`.** Concur with the spec's recommendation: there's nothing to migrate *to* until v2 ships the interface changes, and `[Obsolete]` would flood the build with warnings at zero benefit.

4. **`ViewerLoginHydrator` config-write integration uses a new `IConfigStore` method.** Spec § 4.2 says the hydrator gains a side-write into `config.Github.Accounts[0].Login`; the spec doesn't specify *how*. `IConfigStore.PatchAsync` is restricted to a UI-fields allowlist (`theme`, `accent`, `aiPreview`) and widening it for an internally-set field couples two unrelated concerns. The plan adds a narrow `Task SetDefaultAccountLoginAsync(string login, CancellationToken ct)` method to `IConfigStore` for this v1 single-account scope. v2 generalizes to per-account when the interface changes happen.

5. **`AccountKeys.Default` constant placement.** Spec § 3 says `public const string DefaultAccountKey = "default";` "in `PRism.Core.State`" (the namespace). The plan puts it on a new static class `AccountKeys` with `public const string Default = "default";` (call site: `AccountKeys.Default`). Semantically equivalent; the class wrapper is a C# requirement for top-level consts and the namespace is unchanged.

---

## File structure (created / modified by this PR)

**Created:**
- `PRism.Core/State/AccountState.cs` — new positional record + `Default` static (3 fields: `Reviews`, `AiState`, `LastConfiguredGithubHost`).
- `PRism.Core/State/AccountKeys.cs` — `public static class AccountKeys { public const string Default = "default"; }`.
- `PRism.Core/Config/GithubAccountConfig.cs` — new positional record (4 fields: `Id`, `Host`, `Login`, `LocalWorkspace`). Could be appended to `AppConfig.cs`; the plan puts it in its own file because `AppConfig.cs` is already a record-grab-bag and one more positional record + delegate-property pattern on `GithubConfig` is enough new surface to warrant a sibling file. Match `PRism.Core/State/AccountState.cs`'s placement decision for symmetry.
- `tests/PRism.Core.Tests/State/AccountStateTests.cs` — covers `AccountState.Default`.
- `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs` — covers `WithDefaultReviews` / `WithDefaultAiState` / `WithDefaultLastConfiguredGithubHost`.
- `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV4ToV5Tests.cs` — covers `MigrateV4ToV5` per-step unit tests (mirrors the existing `MigrationStepTests.cs` pattern, if present; create the file standalone if not).
- `tests/PRism.Core.Tests/Config/GithubConfigDelegatesTests.cs` — covers `GithubConfig.Host` / `LocalWorkspace` delegate properties.
- `tests/PRism.Core.Tests/Config/ConfigStoreMigrationTests.cs` — covers the on-load `github.host` → `github.accounts[0]` rewrite + first-launch seed.
- `tests/PRism.Core.Tests/Auth/TokenStoreReshapeTests.cs` — covers legacy-blob migration, versioned-map round-trip, version-discriminator branches.
- `tests/PRism.Core.Tests/Auth/ViewerLoginHydratorConfigWriteTests.cs` — covers the hydrator's config side-write to `accounts[0].login`.

**Modified:**
- `PRism.Core/State/AppState.cs` — reshape `AppState` record; add `AccountState` (if not split out — see above; the plan splits it out); add delegate properties + `WithDefault*` helpers + new `Default`.
- `PRism.Core/State/AppStateStore.cs` — bump `CurrentVersion` to 5; append `MigrateV4ToV5` to `MigrationSteps`; update `EnsureCurrentShape` to backfill `accounts.default.reviews.sessions`.
- `PRism.Core/State/Migrations/AppStateMigrations.cs` — add `MigrateV4ToV5(JsonObject root)`.
- `PRism.Core/Config/AppConfig.cs` — reshape `GithubConfig` (positional record now `(IReadOnlyList<GithubAccountConfig> Accounts)` with delegate `Host` / `LocalWorkspace`); update `AppConfig.Default`.
- `PRism.Core/Config/ConfigStore.cs` — add on-load `github.host` → `github.accounts[0]` rewrite; update first-launch seed; ensure idempotent reload.
- `PRism.Core/Config/IConfigStore.cs` — add `SetDefaultAccountLoginAsync` method.
- `PRism.Core/Auth/ViewerLoginHydrator.cs` — wire the post-validation side-write into `IConfigStore.SetDefaultAccountLoginAsync`.
- `PRism.Core/Auth/TokenStore.cs` — versioned JSON-map (de)serialization; legacy-blob migration on first read; version-discriminator branches with read-only-mode parity.
- `PRism.Web/Endpoints/AuthEndpoints.cs` — rewrite 3 `state with { LastConfiguredGithubHost = ... }` sites to `state.WithDefaultLastConfiguredGithubHost(...)`.
- `PRism.Web/Endpoints/PrDetailEndpoints.cs` — rewrite 2 `state with { Reviews = state.Reviews with { Sessions = ... } }` sites.
- `PRism.Web/Endpoints/PrDraftEndpoints.cs` — rewrite 1 site.
- `PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs` — rewrite 1 site.
- `PRism.Web/Endpoints/PrReloadEndpoints.cs` — rewrite 1 site.
- `PRism.Web/Endpoints/PrSubmitEndpoints.cs` — rewrite 1 site.
- `PRism.Core/Submit/Pipeline/SubmitPipeline.cs:635` — rewrite 1 site. (Missed by spec § 4.1 caller-migration table; added during ce-doc-review.)
- `PRism.Web/TestHooks/TestEndpoints.cs:171` — rewrite 1 site. (`/test/advance-head` test endpoint, env-guarded but production .cs; missed by the spec.)
- `PRism.Core/ServiceCollectionExtensions.cs:84-89` — extend the hand-rolled `ViewerLoginHydrator` factory delegate with `sp.GetRequiredService<IConfigStore>()` as the new 4th constructor argument (see Task 7).
- Existing test files that construct or mutate `AppState` via `with` expressions on the migrated fields (all break under Task 3's reshape; full grep results from `main` at HEAD `4c6ed08`):
  - `tests/PRism.Core.Tests/State/AppStateStoreTests.cs:55, 72`
  - `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs:23, 57`
  - `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs:163, 427`
  - `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs:30` (multi-line `with` block — the regex `with \{ *(Reviews|...)` doesn't catch this one; verify by manual inspection)
  - `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs:506` (multi-line `with` block — same caveat as above)
  - `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStore.cs:48-57` (the `SeedSession` test helper itself — fix the helper once, every Submit pipeline test inherits the fix)
  - `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStoreTests.cs:11`
  - `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointsTestContext.cs:71`
  - `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs:461`
- `tests/PRism.Core.Tests/PrDetail/FakeConfigStore.cs` — add a one-line stub for `SetDefaultAccountLoginAsync` to keep `IConfigStore`'s test fake compiling (see Task 7). `Moq<IConfigStore>` consumers in `InboxPollerTests.cs` / `InboxRefreshOrchestratorTests.cs` auto-stub the new method and need no edits.
- `docs/spec/02-architecture.md` — three sub-section amendments (per spec § 10).
- `docs/spec/05-non-goals.md` — multi-host concurrency row update.
- `docs/roadmap.md` — add S6 PR0 prefix to S6's PR sequence.

---

# Phase 1 — PR0: Multi-account storage-shape scaffold

**PR title:** `feat(s6-pr0): multi-account storage-shape scaffold (state V5, config accounts list, versioned token cache)`

**Spec sections:** § 1 (goal), § 2 (scope, in-scope items 1–8), § 3 (`AccountKey`), § 4.1 (state schema), § 4.2 (config schema), § 4.3 (token store), § 5 (interfaces — no changes), § 7 (constraints v1 places on v2), § 9 (testing), § 10 (project standards updates).

**Goal:** Land the V4 → V5 state migration, the config `accounts` list, the versioned token cache, and the `Login` write-back from `ViewerLoginHydrator` — with zero user-visible delta.

**Files touched:** see "File structure" above.

**Critical-path check before opening the PR:**
- `dotnet build` clean across the solution.
- `dotnet test` green (all existing tests + 6 new test files in this PR).
- `npm run lint` + `npm run build` in `frontend/` green (sanity — this PR doesn't touch TS, but the pre-push checklist requires it).
- Manual smoke: launch PRism with a v4 `state.json` + legacy `config.json` (`github.host` shape) + legacy token cache (single-string PAT) in a temp `--data-dir`; verify all three migrate on first load and the inbox still polls `@me` against `https://github.com`.

---

### Task 1: `AccountKeys.Default` constant

**Files:**
- Create: `PRism.Core/State/AccountKeys.cs`

**Spec:** § 3 (single source of truth).

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/State/AccountKeysTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AccountKeysTests
{
    [Fact]
    public void Default_is_the_literal_default_string()
    {
        AccountKeys.Default.Should().Be("default");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AccountKeysTests`
Expected: FAIL — `The type or namespace name 'AccountKeys' does not exist in the namespace 'PRism.Core.State'`.

- [ ] **Step 3: Write minimal implementation**

Create `PRism.Core/State/AccountKeys.cs`:

```csharp
namespace PRism.Core.State;

/// <summary>
/// Single source of truth for the v1 account key. v1 ships single-account
/// with this literal; v2 introduces UUID generation alongside (or rekeys
/// this literal at first v2 launch — see spec § 3).
/// </summary>
public static class AccountKeys
{
    public const string Default = "default";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AccountKeysTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/State/AccountKeys.cs tests/PRism.Core.Tests/State/AccountKeysTests.cs
git commit -m "feat(s6-pr0): add AccountKeys.Default constant for multi-account scaffold"
```

---

### Task 2: `AccountState` record + `Default`

**Files:**
- Create: `PRism.Core/State/AccountState.cs`
- Create: `tests/PRism.Core.Tests/State/AccountStateTests.cs`

**Spec:** § 4.1 (the per-account record shape).

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Core.Tests/State/AccountStateTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AccountStateTests
{
    [Fact]
    public void Default_has_empty_reviews_empty_repo_clone_map_null_workspace_mtime_and_null_host()
    {
        var defaultState = AccountState.Default;

        defaultState.Reviews.Sessions.Should().BeEmpty();
        defaultState.AiState.RepoCloneMap.Should().BeEmpty();
        defaultState.AiState.WorkspaceMtimeAtLastEnumeration.Should().BeNull();
        defaultState.LastConfiguredGithubHost.Should().BeNull();
    }

    [Fact]
    public void Default_is_a_stable_singleton_reference()
    {
        // ReadOnlyDictionary wrapping inside PrSessionsState.Empty already prevents
        // mutation; this test pins the singleton-instance shape so any future change
        // that switches to a fresh-instance-per-call accessor fails fast (matches
        // the AppState.Default pattern and prevents the shared-mutable-backing-store
        // regression PrSessionsState.Empty's doc-comment calls out).
        AccountState.Default.Should().BeSameAs(AccountState.Default);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AccountStateTests`
Expected: FAIL — `AccountState` doesn't exist.

- [ ] **Step 3: Write minimal implementation**

Create `PRism.Core/State/AccountState.cs`:

```csharp
namespace PRism.Core.State;

/// <summary>
/// Per-account slice of state. v1 has one entry under <see cref="AccountKeys.Default"/>.
/// v2 may add more entries; the dictionary topology in <see cref="AppState.Accounts"/> is
/// advisory (spec § 7) so v2 may restructure with a V5→V6 migration if it chooses.
/// </summary>
public sealed record AccountState(
    PrSessionsState Reviews,
    AiState AiState,
    string? LastConfiguredGithubHost)
{
    public static AccountState Default { get; } = new(
        Reviews: PrSessionsState.Empty,
        AiState: new AiState(new Dictionary<string, RepoCloneEntry>(), null),
        LastConfiguredGithubHost: null);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AccountStateTests`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/State/AccountState.cs tests/PRism.Core.Tests/State/AccountStateTests.cs
git commit -m "feat(s6-pr0): add AccountState record (per-account slice of AppState)"
```

---

### Task 3: Reshape `AppState` to use `Accounts` dictionary (the atomic reshape)

**Files:**
- Modify: `PRism.Core/State/AppState.cs` — full record reshape.
- Modify: `PRism.Web/Endpoints/AuthEndpoints.cs:87`, `:109`, `:134` — `state with { LastConfiguredGithubHost = ... }` → `state.WithDefaultLastConfiguredGithubHost(...)`.
- Modify: `PRism.Web/Endpoints/PrDetailEndpoints.cs:117`, `:188` — `state with { Reviews = ... }` → `state.WithDefaultReviews(...)`.
- Modify: `PRism.Web/Endpoints/PrDraftEndpoints.cs:163` — same.
- Modify: `PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs:65` — same.
- Modify: `PRism.Web/Endpoints/PrReloadEndpoints.cs:169` — same.
- Modify: `PRism.Web/Endpoints/PrSubmitEndpoints.cs:390` — same.
- Modify: every `new AppState(...)` constructor call in `tests/PRism.Core.Tests/`, `tests/PRism.Web.Tests/`, and `PRism.Web/TestHooks/TestEndpoints.cs`.

**Spec:** § 4.1 (record reshape, delegate properties, write helpers, caller migration table).

**Why this is one task, not five:** the `AppState` constructor signature changes from `(int, PrSessionsState, AiState, string?, UiPreferences)` to `(int, UiPreferences, ImmutableDictionary<string, AccountState>)`. Every direct constructor call breaks at the same time, so they must be rewritten in the same commit or the solution doesn't compile. The delegate-property pattern is what lets the *read* sites (`state.Reviews.Sessions[...]`, `state.AiState.RepoCloneMap`, `state.LastConfiguredGithubHost`) keep compiling unchanged — only constructor calls and `with`-expression write sites need rewriting.

**Test driver:** the *outcome* the existing test suite verifies is "all existing `AppStateStoreTests` / `AppStateStoreMigrationTests` / `AppStateStoreUpdateAsyncTests` / endpoint tests still pass after the reshape." This task's own new test (Task 4 below) exercises the `WithDefault*` helpers directly; the regression bar is the existing suite.

- [ ] **Step 1: Write the failing test for `WithDefault*` helpers**

Create `tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs`:

```csharp
using System.Collections.Immutable;
using FluentAssertions;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateWithDefaultHelpersTests
{
    [Fact]
    public void WithDefaultReviews_returns_new_state_with_default_accounts_reviews_replaced()
    {
        var newReviews = new PrSessionsState(new Dictionary<string, ReviewSessionState>
        {
            ["owner/repo/1"] = new ReviewSessionState(
                LastViewedHeadSha: "abc",
                LastSeenCommentId: null,
                PendingReviewId: null,
                PendingReviewCommitOid: null,
                ViewedFiles: new Dictionary<string, string>(),
                DraftComments: System.Array.Empty<DraftComment>(),
                DraftReplies: System.Array.Empty<DraftReply>(),
                DraftSummaryMarkdown: null,
                DraftVerdict: null,
                DraftVerdictStatus: DraftVerdictStatus.Draft)
        });

        var updated = AppState.Default.WithDefaultReviews(newReviews);

        updated.Reviews.Sessions.Should().ContainKey("owner/repo/1");
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(newReviews);
        // Other account-state fields preserved.
        updated.Accounts[AccountKeys.Default].AiState.Should().BeSameAs(AppState.Default.Accounts[AccountKeys.Default].AiState);
        updated.Accounts[AccountKeys.Default].LastConfiguredGithubHost.Should().BeNull();
        // Top-level fields preserved.
        updated.UiPreferences.Should().BeSameAs(AppState.Default.UiPreferences);
        updated.Version.Should().Be(AppState.Default.Version);
    }

    [Fact]
    public void WithDefaultAiState_returns_new_state_with_default_accounts_ai_state_replaced()
    {
        var newAi = new AiState(
            new Dictionary<string, RepoCloneEntry> { ["owner/repo"] = new RepoCloneEntry("/tmp/clone", "user") },
            new System.DateTime(2026, 5, 10, 0, 0, 0, System.DateTimeKind.Utc));

        var updated = AppState.Default.WithDefaultAiState(newAi);

        updated.AiState.Should().BeSameAs(newAi);
        updated.Accounts[AccountKeys.Default].AiState.Should().BeSameAs(newAi);
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(PrSessionsState.Empty);
    }

    [Fact]
    public void WithDefaultLastConfiguredGithubHost_returns_new_state_with_field_replaced()
    {
        var updated = AppState.Default.WithDefaultLastConfiguredGithubHost("https://github.acme.local");

        updated.LastConfiguredGithubHost.Should().Be("https://github.acme.local");
        updated.Accounts[AccountKeys.Default].LastConfiguredGithubHost.Should().Be("https://github.acme.local");
        updated.Accounts[AccountKeys.Default].Reviews.Should().BeSameAs(PrSessionsState.Empty);
    }

    [Fact]
    public void Read_delegate_properties_return_default_accounts_subfields()
    {
        var state = AppState.Default;

        state.Reviews.Should().BeSameAs(state.Accounts[AccountKeys.Default].Reviews);
        state.AiState.Should().BeSameAs(state.Accounts[AccountKeys.Default].AiState);
        state.LastConfiguredGithubHost.Should().Be(state.Accounts[AccountKeys.Default].LastConfiguredGithubHost);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AppStateWithDefaultHelpersTests`
Expected: FAIL — `'AppState' does not contain a definition for 'WithDefaultReviews'`, plus the new tests can't compile against the current `AppState.Default` shape.

- [ ] **Step 3: Reshape `AppState` (replace the entire file contents)**

Replace `PRism.Core/State/AppState.cs` with:

```csharp
using System.Collections.Immutable;

namespace PRism.Core.State;

public sealed record AppState(
    int Version,
    UiPreferences UiPreferences,
    ImmutableDictionary<string, AccountState> Accounts)
{
    // Read delegate properties — preserved to keep call sites compiling unchanged across
    // the V4→V5 reshape. v2 will remove these when interfaces gain accountKey; until then
    // they are part of the public API (see spec § 11 + the deferrals sidecar entry "delegate
    // properties stay public").
    //
    // NB: deliberately NOT marked [Obsolete] in v1 (spec § 11, plan-time decision 3). There is
    // nothing for callers to migrate to until v2 ships the parameterized interface changes, so
    // [Obsolete] would flood the build with warnings at zero benefit (the solution enables
    // TreatWarningsAsErrors). v2's PR that introduces the parameterized replacements applies
    // [Obsolete] in the same change so consumers see deprecation + migration target together.
    public PrSessionsState Reviews => Accounts[AccountKeys.Default].Reviews;
    public AiState AiState => Accounts[AccountKeys.Default].AiState;
    public string? LastConfiguredGithubHost => Accounts[AccountKeys.Default].LastConfiguredGithubHost;

    // Write helpers — replace `state with { Reviews = ... }` patterns. Each helper rebuilds
    // the AccountState entry under AccountKeys.Default and writes it back via
    // ImmutableDictionary.SetItem. The other account-state fields and top-level fields are
    // preserved by record `with` semantics.
    public AppState WithDefaultReviews(PrSessionsState newReviews) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { Reviews = newReviews }) };

    public AppState WithDefaultAiState(AiState newAiState) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { AiState = newAiState }) };

    public AppState WithDefaultLastConfiguredGithubHost(string? newHost) =>
        this with { Accounts = Accounts.SetItem(AccountKeys.Default,
            Accounts[AccountKeys.Default] with { LastConfiguredGithubHost = newHost }) };

    public static AppState Default { get; } = new(
        Version: 5,
        UiPreferences: UiPreferences.Default,
        Accounts: ImmutableDictionary<string, AccountState>.Empty
            .Add(AccountKeys.Default, AccountState.Default));
}

public sealed record ReviewSessionState(
    string? LastViewedHeadSha,
    string? LastSeenCommentId,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    IReadOnlyDictionary<string, string> ViewedFiles,
    IReadOnlyList<DraftComment> DraftComments,
    IReadOnlyList<DraftReply> DraftReplies,
    string? DraftSummaryMarkdown,
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus);

public sealed record DraftComment(
    string Id,
    string? FilePath,
    int? LineNumber,
    string? Side,
    string? AnchoredSha,
    string? AnchoredLineContent,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale,
    string? ThreadId = null);

public sealed record DraftReply(
    string Id,
    string ParentThreadId,
    string? ReplyCommentId,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

public enum DraftVerdict { Approve, RequestChanges, Comment }
public enum DraftVerdictStatus { Draft, NeedsReconfirm }
public enum DraftStatus { Draft, Moved, Stale }

public sealed record AiState(
    IReadOnlyDictionary<string, RepoCloneEntry> RepoCloneMap,
    DateTime? WorkspaceMtimeAtLastEnumeration);

public sealed record RepoCloneEntry(string Path, string Ownership);
```

- [ ] **Step 4: Rewrite production write sites**

For each file/line below, replace the `with`-expression with the corresponding helper. Each one is mechanical.

`PRism.Web/Endpoints/AuthEndpoints.cs:87`:

```csharp
// Before:
await stateStore.SaveAsync(state with { LastConfiguredGithubHost = config.Current.Github.Host }, ct).ConfigureAwait(false);
// After:
await stateStore.SaveAsync(state.WithDefaultLastConfiguredGithubHost(config.Current.Github.Host), ct).ConfigureAwait(false);
```

Apply the same transform at `AuthEndpoints.cs:109` and `AuthEndpoints.cs:134`.

`PRism.Web/Endpoints/PrDetailEndpoints.cs:117` and `:188`:

```csharp
// Before:
return state with { Reviews = state.Reviews with { Sessions = sessions } };
// After:
return state.WithDefaultReviews(state.Reviews with { Sessions = sessions });
```

`PRism.Web/Endpoints/PrDraftEndpoints.cs:163`, `PrDraftsDiscardAllEndpoint.cs:65`, `PrReloadEndpoints.cs:169`, `PrSubmitEndpoints.cs:390`: same transform (each is `state with { Reviews = state.Reviews with { Sessions = ... } }` → `state.WithDefaultReviews(state.Reviews with { Sessions = ... })`).

`PRism.Core/Submit/Pipeline/SubmitPipeline.cs:635`: same transform — this is the in-pipeline overlay write helper. The spec's caller-migration table missed it because the spec § 4.1 enumeration only walked `PRism.Web/Endpoints/`. Required for the pipeline to compile.

`PRism.Web/TestHooks/TestEndpoints.cs:171`: same transform. Env-guarded test endpoint for the Playwright `/test/advance-head` fixture-mutation flow; failing to rewrite means the test endpoint compiles but Playwright e2e tests break at runtime on the first call.

- [ ] **Step 5: Rewrite test-side `with`-expression sites that touch the migrated fields**

The original draft of this step instructed `git grep -n 'new AppState(' -- '*.cs'`. That grep returns **zero matches** on the current codebase — nothing calls the `AppState` constructor directly. Every test construction goes through `AppState.Default with { ... }`, and every such `with`-expression that assigns to `Reviews`, `AiState`, or `LastConfiguredGithubHost` breaks under Task 3's reshape with `CS8852: Init-only property '...' can only be assigned in an object initializer`. Use the correct grep:

```bash
git grep -nE 'with \{ *(Reviews|AiState|LastConfiguredGithubHost) *=' -- '*.cs'
```

This grep misses multi-line `with` blocks (where `{` is on its own line). For those, also run:

```bash
git grep -nA1 'with$' -- '*.cs' | grep -E 'with$|^\s*\{' -A2 | grep -E '(Reviews|AiState|LastConfiguredGithubHost) ='
```

Or simpler, manually inspect the two known multi-line sites: `AppStateRoundTripTests.cs:30` and `InboxRefreshOrchestratorTests.cs:506`.

The complete test-side rewrite list (verified against `main` at HEAD `4c6ed08`):

| File | Line | Pattern |
|---|---|---|
| `tests/PRism.Core.Tests/State/AppStateStoreTests.cs` | 55 | `initial with { LastConfiguredGithubHost = "..." }` → `initial.WithDefaultLastConfiguredGithubHost("...")` |
| `tests/PRism.Core.Tests/State/AppStateStoreTests.cs` | 72 | same |
| `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs` | 23 | `state with { LastConfiguredGithubHost = ... }` → `state.WithDefaultLastConfiguredGithubHost(...)` |
| `tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs` | 57 | `s with { Reviews = s.Reviews with { Sessions = sessions } }` → `s.WithDefaultReviews(s.Reviews with { Sessions = sessions })` |
| `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs` | 163 | `initial with { Reviews = ... }` → `initial.WithDefaultReviews(...)` |
| `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs` | 427 | same |
| `tests/PRism.Core.Tests/State/AppStateRoundTripTests.cs` | 30 (multi-line) | `AppState.Default with { Reviews = ... }` → `AppState.Default.WithDefaultReviews(...)` |
| `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` | 506 (multi-line) | `AppState.Default with { Reviews = ... }` → `AppState.Default.WithDefaultReviews(...)` |
| `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStore.cs` | 48–57 | The `SeedSession` helper — rewrite once; every Submit pipeline test inherits the fix. Replace `_state = _state with { Reviews = _state.Reviews with { Sessions = ... } }` with `_state = _state.WithDefaultReviews(_state.Reviews with { Sessions = ... })`. |
| `tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStoreTests.cs` | 11 | `s with { LastConfiguredGithubHost = ... }` → `s.WithDefaultLastConfiguredGithubHost(...)` |
| `tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs` | 461 | `initial with { Reviews = ... }` → `initial.WithDefaultReviews(...)` |
| `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointsTestContext.cs` | 71 | `state with { Reviews = ... }` → `state.WithDefaultReviews(...)` |

If the corrected grep surfaces a site this list doesn't name, add it — the codebase is moving and new test files land between plan-writing and execution. The grep is the source of truth, not this list.

`AppStateStoreMigrationTests.cs` also reads via `state.Reviews.Sessions[...]` and `state.Version.Should().Be(4)` — the read sites are unaffected (delegate properties), but the version assertions need bumping to 5 in Task 4 step 6 (covered there, not here).

- [ ] **Step 6: Run the new helper tests and the existing suite**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AppStateWithDefaultHelpersTests`
Expected: PASS (4 tests).

Run: `dotnet test`
Expected: PASS — every prior test in `AppStateStoreTests`, `AppStateStoreUpdateAsyncTests`, `AppStateStoreMigrationTests`, `PrDetailEndpointsTests`, and the Submit pipeline fakes continues to pass because the delegate read properties + new helper write methods preserve the prior API. If any test fails, the most likely culprits: a missed constructor-call rewrite (compile error) or a `with`-expression at a write site you didn't update (compile error).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/State/AppState.cs \
        tests/PRism.Core.Tests/State/AppStateWithDefaultHelpersTests.cs \
        PRism.Web/Endpoints/AuthEndpoints.cs \
        PRism.Web/Endpoints/PrDetailEndpoints.cs \
        PRism.Web/Endpoints/PrDraftEndpoints.cs \
        PRism.Web/Endpoints/PrDraftsDiscardAllEndpoint.cs \
        PRism.Web/Endpoints/PrReloadEndpoints.cs \
        PRism.Web/Endpoints/PrSubmitEndpoints.cs \
        tests/PRism.Core.Tests/State/AppStateStoreTests.cs \
        tests/PRism.Core.Tests/State/AppStateStoreUpdateAsyncTests.cs \
        tests/PRism.Core.Tests/Submit/Pipeline/Fakes/InMemoryAppStateStoreTests.cs \
        tests/PRism.Web.Tests/Endpoints/PrDetailEndpointsTests.cs \
        tests/PRism.Web.Tests/TestHelpers/SubmitEndpointsTestContext.cs \
        PRism.Web/TestHooks/TestEndpoints.cs
# Add any other files the grep in step 5 surfaced.
git commit -m "feat(s6-pr0): reshape AppState to Accounts dictionary with delegate properties + WithDefault helpers"
```

---

### Task 4: `MigrateV4ToV5` per-step migration

**Files:**
- Modify: `PRism.Core/State/Migrations/AppStateMigrations.cs` — add `MigrateV4ToV5`.
- Modify: `PRism.Core/State/AppStateStore.cs` — bump `CurrentVersion = 5`, append `(5, AppStateMigrations.MigrateV4ToV5)` to `MigrationSteps`, update `EnsureCurrentShape`.
- Modify: `AppState.Default.Version = 5` (already done in Task 3 step 3 if you followed the code block — verify).
- Create: `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV4ToV5Tests.cs`.

**Spec:** § 4.1 (migration steps).

- [ ] **Step 1: Write the failing per-step migration tests**

Create `tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV4ToV5Tests.cs`:

```csharp
using System.Text.Json.Nodes;
using FluentAssertions;
using PRism.Core.State.Migrations;
using Xunit;

namespace PRism.Core.Tests.State.Migrations;

public class AppStateMigrationsV4ToV5Tests
{
    [Fact]
    public void MigrateV4ToV5_moves_reviews_ai_state_and_last_configured_host_under_accounts_default()
    {
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "abc" } } },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        migrated["version"]!.GetValue<int>().Should().Be(5);
        migrated.ContainsKey("reviews").Should().BeFalse();
        migrated.ContainsKey("ai-state").Should().BeFalse();
        migrated.ContainsKey("last-configured-github-host").Should().BeFalse();
        migrated["ui-preferences"].Should().NotBeNull();
        migrated["accounts"]!.AsObject().Should().ContainKey("default");

        var def = migrated["accounts"]!["default"]!.AsObject();
        def["reviews"]!["sessions"]!["owner/repo/1"]!["last-viewed-head-sha"]!.GetValue<string>().Should().Be("abc");
        def["ai-state"]!["repo-clone-map"]!.AsObject().Should().BeEmpty();
        def["last-configured-github-host"]!.GetValue<string>().Should().Be("https://github.com");
    }

    [Fact]
    public void MigrateV4ToV5_is_idempotent_for_v5_input()
    {
        // The migration framework guards by version comparison (see AppStateStore.MigrateIfNeeded),
        // so this test simulates running the step in isolation against an already-V5 shape.
        // The transform itself should be a no-op when there's nothing at root to move.
        var root = JsonNode.Parse("""
        {
          "version": 5,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "accounts": { "default": { "reviews": { "sessions": {} }, "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null }, "last-configured-github-host": null } }
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        migrated["version"]!.GetValue<int>().Should().Be(5);
        migrated["accounts"]!["default"]!["reviews"].Should().NotBeNull();
        migrated.ContainsKey("reviews").Should().BeFalse();
    }

    [Fact]
    public void MigrateV4ToV5_handles_partially_populated_v4_with_missing_optional_fields()
    {
        // A V4 file with `last-configured-github-host` absent (it's nullable). The migration must
        // produce `accounts.default.last-configured-github-host: null`, not throw and not omit the key.
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": {} },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null }
        }
        """)!.AsObject();

        var migrated = AppStateMigrations.MigrateV4ToV5(root);

        var def = migrated["accounts"]!["default"]!.AsObject();
        def.ContainsKey("last-configured-github-host").Should().BeTrue();
        def["last-configured-github-host"].Should().BeNull();
    }

    [Fact]
    public void MigrateV4ToV5_throws_on_partial_rollback_file_with_both_orphan_root_keys_and_accounts()
    {
        // Hand-edit / partial-rollback scenario from a hypothetical V6 binary back to V4. The user
        // (or a fix-up script) lowered `version: 6` to `version: 4` but left the `accounts` key in
        // alongside re-introduced root-level `reviews`. The naive idempotency check (just `accounts
        // is JsonObject`) would silently drop the user's freshly-edited root-level data; instead we
        // surface as JsonException so AppStateStore.LoadCoreAsync quarantines the file.
        var root = JsonNode.Parse("""
        {
          "version": 4,
          "ui-preferences": { "diff-mode": "side-by-side" },
          "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "freshly-edited" } } },
          "accounts": { "default": { "reviews": { "sessions": { "owner/repo/1": { "last-viewed-head-sha": "stale" } } } } }
        }
        """)!.AsObject();

        Action act = () => AppStateMigrations.MigrateV4ToV5(root);

        act.Should().Throw<System.Text.Json.JsonException>()
            .WithMessage("*partial rollback*");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AppStateMigrationsV4ToV5Tests`
Expected: FAIL — `AppStateMigrations` doesn't have a `MigrateV4ToV5` member.

- [ ] **Step 3: Implement `MigrateV4ToV5`**

Append to `PRism.Core/State/Migrations/AppStateMigrations.cs` (immediately after `MigrateV3ToV4`):

```csharp
    public static JsonObject MigrateV4ToV5(JsonObject root)
    {
        // Idempotency vs partial-rollback discrimination:
        //   - V5 file passed in by mistake (no root-level reviews/ai-state/last-host): just bump
        //     version and return. Idempotent.
        //   - Partial-rollback / hand-edit (BOTH root-level reviews/ai-state/last-host AND a pre-existing
        //     accounts key): refuse to silently pick one set. Surface as JsonException so LoadCoreAsync's
        //     catch (JsonException) quarantines the file. Spec § 8.4 calls this out as "must commit a
        //     policy"; the safe v1 policy is "fail loud, quarantine, AppState.Default + re-Setup."
        var hasOrphanRoot = root["reviews"] is not null
                         || root["ai-state"] is not null
                         || root["last-configured-github-host"] is not null;
        if (root["accounts"] is JsonObject && !hasOrphanRoot)
        {
            root["version"] = 5;
            return root;
        }
        if (root["accounts"] is JsonObject && hasOrphanRoot)
        {
            throw new System.Text.Json.JsonException(
                "state.json has both root-level reviews/ai-state/last-configured-github-host AND an existing " +
                "accounts key. This indicates a partial rollback from a future version or a hand-edit gone " +
                "wrong. Quarantining and re-Setup is safer than guessing which set wins.");
        }

        var reviews = root["reviews"];
        var aiState = root["ai-state"];
        var lastHost = root["last-configured-github-host"];

        var defaultAccount = new JsonObject();
        // JsonNode parented values can't be reused as-is — deep-clone so the keys can be moved
        // under accounts.default without leaving torn references behind.
        defaultAccount["reviews"] = reviews?.DeepClone() ?? new JsonObject { ["sessions"] = new JsonObject() };
        defaultAccount["ai-state"] = aiState?.DeepClone() ?? new JsonObject
        {
            ["repo-clone-map"] = new JsonObject(),
            ["workspace-mtime-at-last-enumeration"] = null
        };
        // last-configured-github-host is nullable on the C# side; preserve null as an explicit JSON
        // null so the post-migration shape's deserializer doesn't trip on missing keys.
        defaultAccount["last-configured-github-host"] = lastHost?.DeepClone();

        root.Remove("reviews");
        root.Remove("ai-state");
        root.Remove("last-configured-github-host");

        root["accounts"] = new JsonObject { ["default"] = defaultAccount };
        root["version"] = 5;
        return root;
    }
```

- [ ] **Step 4: Wire into `AppStateStore.MigrationSteps` and bump `CurrentVersion`**

Modify `PRism.Core/State/AppStateStore.cs`:

```csharp
// Line 10: change
private const int CurrentVersion = 4;
// to:
private const int CurrentVersion = 5;

// Lines 20–26: change the MigrationSteps array initializer
private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
    new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
    {
        (2, AppStateMigrations.MigrateV1ToV2),
        (3, AppStateMigrations.MigrateV2ToV3),
        (4, AppStateMigrations.MigrateV3ToV4),
        (5, AppStateMigrations.MigrateV4ToV5),  // S6 PR0 — moves Reviews/AiState/LastConfiguredGithubHost under accounts.default
    }.OrderBy(s => s.ToVersion).ToArray();
```

- [ ] **Step 5: Update `EnsureCurrentShape` to backfill the new shape**

After V5, the top-level `reviews` key is gone — it lives under `accounts.default.reviews`. The forward-fixup must follow.

Modify `EnsureCurrentShape` in `PRism.Core/State/AppStateStore.cs`:

```csharp
private static void EnsureCurrentShape(JsonObject root)
{
    if (root["ui-preferences"] is null)
        root["ui-preferences"] = new JsonObject { ["diff-mode"] = "side-by-side" };

    // Ensure the V5 accounts container exists with a default entry. A V5 file written by a
    // newer PRism (future-version branch) that omits an optional sub-field still needs the
    // structural backbone in place for deserialization to succeed.
    if (root["accounts"] is not JsonObject accountsObj)
    {
        accountsObj = new JsonObject();
        root["accounts"] = accountsObj;
    }
    if (accountsObj["default"] is not JsonObject defaultObj)
    {
        defaultObj = new JsonObject();
        accountsObj["default"] = defaultObj;
    }

    // Forward-fixup the reviews.sessions backbone under accounts.default (the V3-era equivalent
    // applied at the root; V5 moves it under the account).
    if (defaultObj["reviews"] is null)
    {
        defaultObj["reviews"] = new JsonObject { ["sessions"] = new JsonObject() };
    }
    else if (defaultObj["reviews"] is JsonObject reviewsObj && reviewsObj["sessions"] is null)
    {
        // Defense against partial wraps: { "reviews": {} } would otherwise cause
        // state.Reviews.Sessions to deserialize to null and crash the first TryGetValue caller.
        reviewsObj["sessions"] = new JsonObject();
    }

    if (defaultObj["ai-state"] is null)
    {
        defaultObj["ai-state"] = new JsonObject
        {
            ["repo-clone-map"] = new JsonObject(),
            ["workspace-mtime-at-last-enumeration"] = null
        };
    }
}
```

- [ ] **Step 6: Run the per-step tests + the end-to-end migration tests**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AppStateMigrationsV4ToV5Tests`
Expected: PASS (3 tests).

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~AppStateStoreMigrationTests`
Expected: PASS — the existing tests assert `state.Version.Should().Be(4)` will fail. Update each `Should().Be(4)` to `Should().Be(5)` in `AppStateStoreMigrationTests.cs`; the per-step migrations through V4→V5 chain transparently because the delegate property `state.Reviews.Sessions[...]` resolves to `state.Accounts["default"].Reviews.Sessions[...]`.

Specifically search the file for `Be(4)` and update each call site that asserts the current schema version:

```bash
git grep -n 'Should().Be(4)' tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs
```

- [ ] **Step 7: Add an end-to-end V4 → V5 LoadAsync test**

Append to `tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs`:

```csharp
[Fact]
public async Task LoadAsync_migrates_v4_state_file_to_v5_and_moves_reviews_under_accounts_default()
{
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
    {
      "version": 4,
      "ui-preferences": { "diff-mode": "unified" },
      "reviews": {
        "sessions": {
          "owner/repo/7": {
            "last-viewed-head-sha": "head7",
            "last-seen-comment-id": "c1",
            "pending-review-id": null,
            "pending-review-commit-oid": null,
            "viewed-files": { "src/Foo.cs": "abc" },
            "draft-comments": [],
            "draft-replies": [],
            "draft-summary-markdown": null,
            "draft-verdict": null,
            "draft-verdict-status": "Draft"
          }
        }
      },
      "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
      "last-configured-github-host": "https://github.com"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    var state = await store.LoadAsync(CancellationToken.None);

    state.Version.Should().Be(5);
    state.Reviews.Sessions.Should().ContainKey("owner/repo/7");
    state.Reviews.Sessions["owner/repo/7"].ViewedFiles.Should().ContainKey("src/Foo.cs");
    state.LastConfiguredGithubHost.Should().Be("https://github.com");
    state.UiPreferences.Should().NotBeNull();
    state.Accounts.Should().ContainKey("default");
    store.IsReadOnlyMode.Should().BeFalse();
}

[Fact]
public async Task LoadAsync_future_version_V6_file_enters_read_only_mode_and_EnsureCurrentShape_backfills_safely()
{
    // Future-version coverage (ce-doc-review adversarial F6): a V6 file with extra keys + missing
    // optional sub-fields under accounts.default must NOT trip EnsureCurrentShape's backfill into
    // a deserialization NRE, AND must enter read-only mode so SaveAsync is blocked.
    using var dir = new TempDataDir();
    await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
    {
      "version": 6,
      "ui-preferences": { "diff-mode": "side-by-side" },
      "accounts": {
        "default": {
          "v6-future-account-metadata": { "extra": "ignored-by-deserializer" }
        }
      },
      "v6-future-root-key": "ignored-by-deserializer"
    }
    """);

    using var store = new AppStateStore(dir.Path);
    var state = await store.LoadAsync(CancellationToken.None);

    store.IsReadOnlyMode.Should().BeTrue();
    state.Version.Should().Be(6);                  // version preserved for the surfacing message
    state.Reviews.Sessions.Should().BeEmpty();     // backfilled by EnsureCurrentShape
    state.AiState.RepoCloneMap.Should().BeEmpty(); // backfilled by EnsureCurrentShape
    state.LastConfiguredGithubHost.Should().BeNull(); // nullable; missing key deserializes to null safely

    // SaveAsync MUST refuse — proves read-only mode enforcement, not just the surfacing message.
    Func<Task> save = () => store.SaveAsync(state, CancellationToken.None);
    await save.Should().ThrowAsync<InvalidOperationException>()
        .WithMessage("*read-only mode*");
}
```

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~LoadAsync_migrates_v4_state_file_to_v5`
Expected: PASS.

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~LoadAsync_future_version_V6`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add PRism.Core/State/Migrations/AppStateMigrations.cs \
        PRism.Core/State/AppStateStore.cs \
        tests/PRism.Core.Tests/State/Migrations/AppStateMigrationsV4ToV5Tests.cs \
        tests/PRism.Core.Tests/State/AppStateStoreMigrationTests.cs
git commit -m "feat(s6-pr0): add MigrateV4ToV5 (moves reviews/ai-state/host under accounts.default)"
```

---

### Task 5: `GithubAccountConfig` record + `GithubConfig` reshape

**Files:**
- Create: `PRism.Core/Config/GithubAccountConfig.cs`
- Modify: `PRism.Core/Config/AppConfig.cs` — reshape `GithubConfig`, update `AppConfig.Default`.
- Create: `tests/PRism.Core.Tests/Config/GithubConfigDelegatesTests.cs`.

**Spec:** § 4.2 (config schema, delegate properties on `GithubConfig`).

- [ ] **Step 1: Write the failing tests for `GithubConfig` delegate properties**

Create `tests/PRism.Core.Tests/Config/GithubConfigDelegatesTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.State;
using Xunit;

namespace PRism.Core.Tests.Config;

public class GithubConfigDelegatesTests
{
    [Fact]
    public void Host_delegates_to_accounts_first_entry()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.acme.local",
                Login: "alice",
                LocalWorkspace: "/work")
        });

        cfg.Host.Should().Be("https://github.acme.local");
    }

    [Fact]
    public void LocalWorkspace_delegates_to_accounts_first_entry()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.com",
                Login: null,
                LocalWorkspace: "/Users/alice/code")
        });

        cfg.LocalWorkspace.Should().Be("/Users/alice/code");
    }

    [Fact]
    public void LocalWorkspace_is_null_when_account_local_workspace_is_null()
    {
        var cfg = new GithubConfig(new[]
        {
            new GithubAccountConfig(
                Id: AccountKeys.Default,
                Host: "https://github.com",
                Login: null,
                LocalWorkspace: null)
        });

        cfg.LocalWorkspace.Should().BeNull();
    }

    [Fact]
    public void AppConfig_Default_constructs_a_single_default_account_with_github_dot_com_and_null_login_and_null_workspace()
    {
        var def = AppConfig.Default;

        def.Github.Accounts.Should().HaveCount(1);
        def.Github.Accounts[0].Id.Should().Be(AccountKeys.Default);
        def.Github.Accounts[0].Host.Should().Be("https://github.com");
        def.Github.Accounts[0].Login.Should().BeNull();
        def.Github.Accounts[0].LocalWorkspace.Should().BeNull();
        // Delegate properties preserve the existing AppConfig.Github.Host/LocalWorkspace API.
        def.Github.Host.Should().Be("https://github.com");
        def.Github.LocalWorkspace.Should().BeNull();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~GithubConfigDelegatesTests`
Expected: FAIL — `GithubAccountConfig` doesn't exist, `GithubConfig` constructor signature mismatch.

- [ ] **Step 3: Implement `GithubAccountConfig`**

Create `PRism.Core/Config/GithubAccountConfig.cs`:

```csharp
namespace PRism.Core.Config;

/// <summary>
/// Per-account GitHub configuration. v1 stores one entry under the default account key
/// (see <see cref="PRism.Core.State.AccountKeys.Default"/>). The on-disk JSON shape uses
/// kebab-case keys via <see cref="PRism.Core.Json.JsonSerializerOptionsFactory.Storage"/>:
/// <c>{ "id": "default", "host": "...", "login": null, "local-workspace": null }</c>.
/// </summary>
/// <param name="Id">Stable account identifier. v1 is always <c>"default"</c>; v2 may introduce UUIDs.</param>
/// <param name="Host">GitHub host URL (e.g. <c>https://github.com</c> or a GHES origin). Non-null.</param>
/// <param name="Login">GitHub viewer login for this account. Null until first PAT validation populates it via <see cref="PRism.Core.Auth.ViewerLoginHydrator"/>.</param>
/// <param name="LocalWorkspace">Per-account local clone root path. Null when the user hasn't configured one.</param>
public sealed record GithubAccountConfig(
    string Id,
    string Host,
    string? Login,
    string? LocalWorkspace);
```

- [ ] **Step 4: Reshape `GithubConfig` and update `AppConfig.Default`**

Modify `PRism.Core/Config/AppConfig.cs`:

```csharp
// Lines 17–26: AppConfig.Default — replace the GithubConfig constructor invocation. The default uses
// expression-bodied `=> new(...)` with positional args; preserve that syntactic form rather than
// converting to a property body or named args (avoid noise in the diff).
public static AppConfig Default => new(
    new PollingConfig(30, 120),
    new InboxConfig(true, new InboxSectionsConfig(true, true, true, true, true), true),
    new ReviewConfig(true, true),
    new IterationsConfig(60, ClusteringDisabled: false),
    new LoggingConfig("info", true, 30),
    new UiConfig("system", "indigo", false),
    new GithubConfig(new[]
    {
        new GithubAccountConfig(
            Id: PRism.Core.State.AccountKeys.Default,
            Host: "https://github.com",
            Login: null,
            LocalWorkspace: null)
    }),
    new LlmConfig());

// Line 43: replace
public sealed record GithubConfig(string Host, string? LocalWorkspace);
// with:
public sealed record GithubConfig(IReadOnlyList<GithubAccountConfig> Accounts)
{
    // Read delegate properties — preserved so existing AppConfig.Github.Host /
    // AppConfig.Github.LocalWorkspace call sites compile unchanged. v2 removes these when
    // host-dependent DI registrations gain per-account awareness.
    public string Host => Accounts[0].Host;
    public string? LocalWorkspace => Accounts[0].LocalWorkspace;
}
```

Add `using PRism.Core.State;` at the top of `AppConfig.cs` if not already present, so `AccountKeys` resolves without the full namespace prefix — match whatever the file's existing using style is.

- [ ] **Step 5: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~GithubConfigDelegatesTests`
Expected: PASS (4 tests).

Run: `dotnet test`
Expected: PASS — every `config.Github.Host` / `config.Github.LocalWorkspace` call site keeps working via the delegate properties. If any test fails due to JSON serialization shape (an old `GithubConfig` snapshot in a test fixture, for example), that fixture needs updating to the new on-disk shape — capture which one and move to Task 6 (`ConfigStore` migration) where the new shape is exercised end-to-end.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Config/GithubAccountConfig.cs \
        PRism.Core/Config/AppConfig.cs \
        tests/PRism.Core.Tests/Config/GithubConfigDelegatesTests.cs
git commit -m "feat(s6-pr0): reshape GithubConfig to Accounts list with delegate Host/LocalWorkspace"
```

---

### Task 6: `ConfigStore` migration on load (`github.host` → `github.accounts[0]`)

**Files:**
- Modify: `PRism.Core/Config/ConfigStore.cs` — add a `JsonNode`-level rewrite in `ReadFromDiskAsync` before the `Deserialize<AppConfig>` call.
- Create: `tests/PRism.Core.Tests/Config/ConfigStoreMigrationTests.cs`.

**Spec:** § 4.2 (`ConfigStore` load path: migration, idempotence, atomic-rename write).

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Config/ConfigStoreMigrationTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreMigrationTests
{
    [Fact]
    public async Task InitAsync_rewrites_legacy_github_host_to_accounts_array_with_local_workspace_moved_under_account()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": { "host": "https://github.acme.local", "local-workspace": "/Users/alice/code" }
        }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        var account = store.Current.Github.Accounts[0];
        account.Id.Should().Be(AccountKeys.Default);
        account.Host.Should().Be("https://github.acme.local");
        account.Login.Should().BeNull();
        account.LocalWorkspace.Should().Be("/Users/alice/code");

        // Delegate properties preserve the existing API surface.
        store.Current.Github.Host.Should().Be("https://github.acme.local");
        store.Current.Github.LocalWorkspace.Should().Be("/Users/alice/code");
    }

    [Fact]
    public async Task InitAsync_is_idempotent_for_already_accounts_shaped_config()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "alice", "local-workspace": null }
            ]
          }
        }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].Login.Should().Be("alice");
    }

    [Fact]
    public async Task InitAsync_writes_seeded_default_account_on_first_launch_when_no_config_file_exists()
    {
        using var dir = new TempDataDir();
        // No config.json on disk.

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        var account = store.Current.Github.Accounts[0];
        account.Id.Should().Be(AccountKeys.Default);
        account.Host.Should().Be("https://github.com");
        account.Login.Should().BeNull();
        account.LocalWorkspace.Should().BeNull();

        // The seeded config is written to disk so the next launch reads the new shape.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "config.json"));
        raw.Should().Contain("\"accounts\"");
        raw.Should().NotContain("\"host\": \"https://github.com\"\n");  // ensure not top-level on github
    }

    [Fact]
    public async Task InitAsync_handles_legacy_github_with_null_local_workspace()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        { "github": { "host": "https://github.com", "local-workspace": null } }
        """);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Github.Accounts.Should().HaveCount(1);
        store.Current.Github.Accounts[0].LocalWorkspace.Should().BeNull();
    }

    [Fact]
    public async Task SetDefaultAccountLoginAsync_concurrent_with_PatchAsync_preserves_both_writes()
    {
        // ce-doc-review adversarial F3: SetDefaultAccountLoginAsync triggers ConfigStore's
        // FileSystemWatcher → HandleFileChangedAsync feedback loop, which re-reads the file under
        // the same _gate and raises Changed a second time. If a concurrent PatchAsync (theme=dark)
        // hits between the write and the watcher re-read, both writes must survive — the test
        // pins this contract so a future "let's suppress the watcher event after our own write"
        // optimization doesn't accidentally drop a concurrent change.
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "ui": { "theme": "light", "accent": "indigo", "ai-preview": false },
          "github": {
            "accounts": [ { "id": "default", "host": "https://github.com", "login": null, "local-workspace": null } ]
          }
        }
        """);
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        // Drive both writes nearly concurrently. The store's _gate serializes them so the result
        // is deterministic regardless of ordering — but the FSW re-read fires for each and could
        // overwrite the in-memory _current with the latest on-disk shape. Drain pending FSW
        // events before asserting (the debounce delay is 100ms in HandleFileChangedAsync).
        var loginWrite = store.SetDefaultAccountLoginAsync("alice", CancellationToken.None);
        var themeWrite = store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);
        await Task.WhenAll(loginWrite, themeWrite);
        await Task.Delay(250);  // drain debounced FSW events

        store.Current.Ui.Theme.Should().Be("dark");
        store.Current.Github.Accounts[0].Login.Should().Be("alice");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ConfigStoreMigrationTests`
Expected: FAIL — the legacy-shape config triggers a `JsonException` because `GithubConfig` no longer accepts `(string Host, string? LocalWorkspace)` positionally. The other tests may pass partially (idempotent + fresh-install paths) depending on the state of the seeded fallback.

- [ ] **Step 3: Implement the JsonNode-level rewrite in `ConfigStore.ReadFromDiskAsync`**

Modify `PRism.Core/Config/ConfigStore.cs` — replace `ReadFromDiskAsync`'s body:

```csharp
private async Task ReadFromDiskAsync(CancellationToken ct)
{
    if (!File.Exists(_path))
    {
        _current = AppConfig.Default;
        await WriteToDiskAsync(ct).ConfigureAwait(false);
        LastLoadError = null;
        return;
    }
    try
    {
        string raw;
        using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var reader = new StreamReader(fs))
            raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

        // First pass: legacy-shape rewrite. If the on-disk config still has the V3 shape
        // (`github.host` and `github.local-workspace` at the github level), rewrite it to the
        // V4 accounts shape before deserialization. This is a JsonNode-level rewrite (no
        // strongly-typed AppConfig allocated yet) so we can rewrite without tripping the
        // GithubConfig constructor mismatch. Atomic-rename write below ensures partial
        // writes can't leave the file with both shapes.
        var rootNode = System.Text.Json.Nodes.JsonNode.Parse(raw, documentOptions: new System.Text.Json.JsonDocumentOptions
        {
            AllowTrailingCommas = true,
            CommentHandling = System.Text.Json.JsonCommentHandling.Skip
        });
        bool rewritten = false;
        if (rootNode is System.Text.Json.Nodes.JsonObject rootObj
            && rootObj["github"] is System.Text.Json.Nodes.JsonObject github
            && github["accounts"] is null
            && github["host"] is System.Text.Json.Nodes.JsonNode hostNode)
        {
            var host = hostNode.GetValue<string>();
            var localWorkspaceNode = github["local-workspace"];
            string? localWorkspace = localWorkspaceNode is null ? null : localWorkspaceNode.GetValue<string?>();

            var account = new System.Text.Json.Nodes.JsonObject
            {
                ["id"] = AccountKeys.Default,
                ["host"] = host,
                ["login"] = null,
                ["local-workspace"] = localWorkspace,
            };
            github.Remove("host");
            github.Remove("local-workspace");
            github["accounts"] = new System.Text.Json.Nodes.JsonArray(account);
            rewritten = true;
            raw = rootNode.ToJsonString();
        }

        var parsed = System.Text.Json.JsonSerializer.Deserialize<AppConfig>(raw, JsonSerializerOptionsFactory.Storage);
        if (parsed is null)
        {
            _current = AppConfig.Default;
            LastLoadError = null;
            return;
        }

        // Backfill any sub-record that's null on disk (unchanged from prior versions). The
        // Inbox guard keeps its two-level shape per the existing comment block. Github falls
        // back to AppConfig.Default's seeded shape if absent or malformed.
        parsed = parsed with
        {
            Polling    = parsed.Polling    ?? AppConfig.Default.Polling,
            Inbox      = parsed.Inbox is null
                            ? AppConfig.Default.Inbox
                            : parsed.Inbox.Sections is null
                                ? AppConfig.Default.Inbox with { ShowHiddenScopeFooter = parsed.Inbox.ShowHiddenScopeFooter }
                                : parsed.Inbox,
            Review     = parsed.Review     ?? AppConfig.Default.Review,
            Iterations = parsed.Iterations ?? AppConfig.Default.Iterations,
            Logging    = parsed.Logging    ?? AppConfig.Default.Logging,
            Ui         = parsed.Ui         ?? AppConfig.Default.Ui,
            Github     = parsed.Github     ?? AppConfig.Default.Github,
            Llm        = parsed.Llm        ?? AppConfig.Default.Llm,
        };

        // Defensive: a partial on-disk shape with `github: {}` deserializes to a
        // GithubConfig with a null/empty Accounts list. Backfill the default-account entry so
        // the delegate property `config.Github.Host` doesn't IndexOutOfRange on `Accounts[0]`.
        if (parsed.Github.Accounts is null || parsed.Github.Accounts.Count == 0)
        {
            parsed = parsed with { Github = AppConfig.Default.Github };
        }

        _current = parsed;
        LastLoadError = null;

        // If we rewrote the legacy shape, persist the new shape to disk so subsequent loads
        // skip the rewrite path. Atomic-rename via WriteToDiskAsync.
        if (rewritten)
        {
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
    }
    catch (Exception ex) when (ex is System.Text.Json.JsonException or IOException or UnauthorizedAccessException)
    {
        LastLoadError = ex;
        _current = AppConfig.Default;
        // do NOT overwrite the broken file
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ConfigStoreMigrationTests`
Expected: PASS (4 tests).

Run: `dotnet test`
Expected: PASS — no other test changes config-load shape. If a snapshot test in `tests/PRism.Web.Tests/` was pinning the on-disk config JSON, update its fixture to the new accounts-shape. Use `git grep '"host":' tests/` to scan.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Config/ConfigStore.cs \
        tests/PRism.Core.Tests/Config/ConfigStoreMigrationTests.cs
git commit -m "feat(s6-pr0): rewrite legacy github.host config shape to accounts[0] on load"
```

---

### Task 7: `IConfigStore.SetDefaultAccountLoginAsync` + `ViewerLoginHydrator` side-write

**Files:**
- Modify: `PRism.Core/Config/IConfigStore.cs` — add `SetDefaultAccountLoginAsync` method.
- Modify: `PRism.Core/Config/ConfigStore.cs` — implement it.
- Modify: `PRism.Core/Auth/ViewerLoginHydrator.cs` — accept `IConfigStore` via constructor and call it after successful validation.
- Modify: `PRism.Core/ServiceCollectionExtensions.cs` — adjust the hydrator's DI registration if it lists constructor args explicitly (otherwise no change needed).
- Create: `tests/PRism.Core.Tests/Auth/ViewerLoginHydratorConfigWriteTests.cs`.

**Spec:** § 4.2 (login write-back); plan-time decision 4 (new narrow method on `IConfigStore`).

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Auth/ViewerLoginHydratorConfigWriteTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Auth;
using PRism.Core.Config;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class ViewerLoginHydratorConfigWriteTests
{
    [Fact]
    public async Task StartAsync_writes_validated_login_into_config_accounts_default_login()
    {
        using var dir = new TempDataDir();
        // Seed config with the new accounts shape but null login.
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": null, "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: true);
        var review = new FakeReviewAuth(new ValidateCredentialsResult(Ok: true, Login: "alice", Warning: null, Error: null));
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        loginCache.Get().Should().Be("alice");
        config.Current.Github.Accounts[0].Login.Should().Be("alice");
    }

    [Fact]
    public async Task StartAsync_does_not_clobber_config_login_when_no_token_present()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "preserved-login", "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: false);
        var review = new FakeReviewAuth(throwOnValidate: true);  // would throw if called
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        // No token → ValidateCredentialsAsync never runs → config.login stays as-is.
        config.Current.Github.Accounts[0].Login.Should().Be("preserved-login");
    }

    [Fact]
    public async Task StartAsync_does_not_overwrite_config_login_when_validation_fails()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "config.json"), """
        {
          "github": {
            "accounts": [
              { "id": "default", "host": "https://github.com", "login": "stale-login", "local-workspace": null }
            ]
          }
        }
        """);
        using var config = new ConfigStore(dir.Path);
        await config.InitAsync(CancellationToken.None);

        var tokens = new FakeTokenStore(hasToken: true);
        var review = new FakeReviewAuth(new ValidateCredentialsResult(Ok: false, Login: null, Warning: null, Error: ValidateCredentialsErrorCode.TokenInvalid));
        var loginCache = new InMemoryViewerLoginProvider();

        var hydrator = new ViewerLoginHydrator(tokens, review, loginCache, config, NullLogger<ViewerLoginHydrator>.Instance);
        await hydrator.StartAsync(CancellationToken.None);

        // Validation rejected → the existing (potentially stale) login stays; user must reauth at Setup.
        config.Current.Github.Accounts[0].Login.Should().Be("stale-login");
    }
}
```

This test file references three helpers that may already exist or may need stubbing: `FakeTokenStore`, `FakeReviewAuth`, `InMemoryViewerLoginProvider`. Check `tests/PRism.Core.Tests/TestHelpers/` first — re-use what's there. If a helper doesn't exist, add a minimal one in `tests/PRism.Core.Tests/TestHelpers/`:

```csharp
// tests/PRism.Core.Tests/TestHelpers/InMemoryViewerLoginProvider.cs
using PRism.Core.Auth;

namespace PRism.Core.Tests.TestHelpers;

internal sealed class InMemoryViewerLoginProvider : IViewerLoginProvider
{
    private string _login = "";
    public string Get() => _login;
    public void Set(string login) => _login = login;
}
```

If `FakeTokenStore` and `FakeReviewAuth` aren't already in `TestHelpers/`, build them likewise — minimal in-memory stubs. The exact signature of `ValidateCredentialsResult` lives in `PRism.Core.Auth`; mirror it.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ViewerLoginHydratorConfigWriteTests`
Expected: FAIL — `ViewerLoginHydrator` constructor doesn't accept `IConfigStore`; `IConfigStore` doesn't have `SetDefaultAccountLoginAsync`.

- [ ] **Step 3: Extend `IConfigStore` with `SetDefaultAccountLoginAsync`**

Modify `PRism.Core/Config/IConfigStore.cs`:

```csharp
namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }
    Exception? LastLoadError { get; }
    Task InitAsync(CancellationToken ct);
    Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct);
    /// <summary>
    /// Sets <c>github.accounts[0].login</c> for the v1 default account. The login is
    /// populated by <see cref="PRism.Core.Auth.ViewerLoginHydrator"/> the first time
    /// <see cref="IReviewAuth.ValidateCredentialsAsync"/> succeeds after Setup, and by
    /// the connect endpoints during the auth dance. v2 generalizes this to per-account
    /// when the interface gains an account key parameter.
    /// </summary>
    Task SetDefaultAccountLoginAsync(string login, CancellationToken ct);
    event EventHandler<ConfigChangedEventArgs>? Changed;
}
```

- [ ] **Step 4: Implement `SetDefaultAccountLoginAsync` in `ConfigStore`**

Append to `PRism.Core/Config/ConfigStore.cs`'s class body (before the existing `Dispose`):

```csharp
public async Task SetDefaultAccountLoginAsync(string login, CancellationToken ct)
{
    ArgumentNullException.ThrowIfNull(login);

    await _gate.WaitAsync(ct).ConfigureAwait(false);
    try
    {
        var accounts = _current.Github.Accounts.ToList();
        if (accounts.Count == 0)
        {
            // Defensive: a misshapen config that somehow reached this point gets a fresh
            // default-account entry rather than tripping IndexOutOfRange. The on-disk write
            // below persists the seeded shape.
            accounts.Add(new GithubAccountConfig(
                Id: PRism.Core.State.AccountKeys.Default,
                Host: AppConfig.Default.Github.Host,
                Login: login,
                LocalWorkspace: null));
        }
        else
        {
            accounts[0] = accounts[0] with { Login = login };
        }
        _current = _current with { Github = new GithubConfig(accounts) };
        await WriteToDiskAsync(ct).ConfigureAwait(false);
    }
    finally
    {
        _gate.Release();
    }
    RaiseChanged();
}
```

- [ ] **Step 5: Update `ViewerLoginHydrator` to accept `IConfigStore` and call it**

Modify `PRism.Core/Auth/ViewerLoginHydrator.cs`:

```csharp
using System.Diagnostics.CodeAnalysis;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;

namespace PRism.Core.Auth;

/// <summary>
/// On startup, if a stored token exists, validates credentials once, caches the resulting
/// viewer login in <see cref="IViewerLoginProvider"/>, and side-writes the login into
/// <c>config.github.accounts[0].login</c> via <see cref="IConfigStore.SetDefaultAccountLoginAsync"/>.
/// The config write keeps v1's per-account login field populated for v2's eventual display logic
/// without coupling that surface to the in-memory <see cref="IViewerLoginProvider"/> cache.
/// </summary>
public sealed partial class ViewerLoginHydrator : IHostedService
{
    private readonly ITokenStore _tokens;
    private readonly IReviewAuth _review;
    private readonly IViewerLoginProvider _loginCache;
    private readonly IConfigStore _config;
    private readonly ILogger<ViewerLoginHydrator> _log;

    public ViewerLoginHydrator(
        ITokenStore tokens,
        IReviewAuth review,
        IViewerLoginProvider loginCache,
        IConfigStore config,
        ILogger<ViewerLoginHydrator> log)
    {
        _tokens = tokens;
        _review = review;
        _loginCache = loginCache;
        _config = config;
        _log = log;
    }

    [SuppressMessage("Design", "CA1031:Do not catch general exception types",
        Justification = "Cold-start hydration is best-effort: any failure beyond cancellation must leave the host startable so the user can re-authenticate via /api/auth/connect.")]
    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (!string.IsNullOrEmpty(_loginCache.Get())) return;

        bool hasToken;
        try
        {
            hasToken = await _tokens.HasTokenAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            Log.HasTokenProbeFailed(_log, ex);
            return;
        }

        if (!hasToken) return;

        try
        {
            var result = await _review.ValidateCredentialsAsync(cancellationToken).ConfigureAwait(false);
            if (result.Ok && !string.IsNullOrEmpty(result.Login))
            {
                _loginCache.Set(result.Login);
                try
                {
                    await _config.SetDefaultAccountLoginAsync(result.Login, cancellationToken).ConfigureAwait(false);
                }
                catch (OperationCanceledException) { throw; }
                catch (Exception ex)
                {
                    // Best-effort: failure to write the per-account login into config must not block
                    // hydration. The in-memory IViewerLoginProvider already has the login, so v1's
                    // single-account runtime continues to work; v2 will surface this gap if it relies
                    // on the config-side login as a hard source of truth (see spec § 7 advisory).
                    Log.ConfigLoginWriteFailed(_log, ex);
                }
            }
            else
            {
                Log.ValidationRejected(_log, result.Error?.ToString() ?? "unknown");
            }
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            Log.ValidationFailed(_log, ex);
        }
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: HasTokenAsync probe failed; awaiting-author section may be empty until re-auth")]
        internal static partial void HasTokenProbeFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: ValidateCredentialsAsync rejected stored token ({Error}); awaiting-author section may be empty until re-auth")]
        internal static partial void ValidationRejected(ILogger logger, string error);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: ValidateCredentialsAsync threw; awaiting-author section may be empty until next /api/auth/connect")]
        internal static partial void ValidationFailed(ILogger logger, Exception ex);

        [LoggerMessage(Level = LogLevel.Warning, Message = "Viewer login hydration: config.github.accounts[0].login write failed; the in-memory login cache is set but the on-disk login is stale until next successful connect")]
        internal static partial void ConfigLoginWriteFailed(ILogger logger, Exception ex);
    }
}
```

- [ ] **Step 6: Update the `ViewerLoginHydrator` DI factory (REQUIRED — not conditional)**

`PRism.Core/ServiceCollectionExtensions.cs:84-89` registers `ViewerLoginHydrator` via a hand-rolled factory delegate, NOT via auto-resolution. The new `IConfigStore` constructor argument must be passed explicitly or the project won't compile. Edit the factory:

```csharp
// Before:
services.AddHostedService<ViewerLoginHydrator>(sp =>
    new ViewerLoginHydrator(
        sp.GetRequiredService<ITokenStore>(),
        sp.GetRequiredService<IReviewAuth>(),
        sp.GetRequiredService<IViewerLoginProvider>(),
        sp.GetRequiredService<ILogger<ViewerLoginHydrator>>()));

// After:
services.AddHostedService<ViewerLoginHydrator>(sp =>
    new ViewerLoginHydrator(
        sp.GetRequiredService<ITokenStore>(),
        sp.GetRequiredService<IReviewAuth>(),
        sp.GetRequiredService<IViewerLoginProvider>(),
        sp.GetRequiredService<IConfigStore>(),
        sp.GetRequiredService<ILogger<ViewerLoginHydrator>>()));
```

DI lifetime check: `IConfigStore` is registered as a singleton elsewhere in `ServiceCollectionExtensions.cs`; the hydrator is a hosted service, also effectively singleton in lifetime. Same scope; no captive-dependency concern.

DI ordering check: `ConfigStore.InitAsync` is awaited in `Program.cs` before `app.Run()`, which is before any `IHostedService.StartAsync` fires. So `ViewerLoginHydrator.StartAsync` sees a fully-initialized `_config.Current`. Confirm this is still true in `Program.cs` (search for `await configStore.InitAsync` or similar); if the host has changed to an unawaited init, surface to the user before proceeding.

- [ ] **Step 7: Stub `SetDefaultAccountLoginAsync` on `FakeConfigStore` (REQUIRED to keep tests compiling)**

`tests/PRism.Core.Tests/PrDetail/FakeConfigStore.cs` implements `IConfigStore` with explicit method stubs. Adding the new method to the interface forces a stub. Add:

```csharp
public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
```

`Moq<IConfigStore>` consumers (`InboxPollerTests.cs:24, 173, 237, 286, 331`; `InboxRefreshOrchestratorTests.cs:99`) auto-stub the new method and need no edits.

- [ ] **Step 8: Run tests**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~ViewerLoginHydratorConfigWriteTests`
Expected: PASS (3 tests).

Run: `dotnet test`
Expected: PASS — the DI factory edit + `FakeConfigStore` stub keep the rest of the suite compiling. If any other test file implements `IConfigStore` directly (search `git grep -l ': IConfigStore'`), add the same one-line stub there too.

- [ ] **Step 9: Commit**

```bash
git add PRism.Core/Config/IConfigStore.cs \
        PRism.Core/Config/ConfigStore.cs \
        PRism.Core/Auth/ViewerLoginHydrator.cs \
        PRism.Core/ServiceCollectionExtensions.cs \
        tests/PRism.Core.Tests/Auth/ViewerLoginHydratorConfigWriteTests.cs \
        tests/PRism.Core.Tests/PrDetail/FakeConfigStore.cs
# plus any new TestHelpers files created, and any other IConfigStore-implementing test file the grep surfaced.
git commit -m "feat(s6-pr0): hydrator writes validated login to config.accounts[0].login"
```

---

### Task 8: `TokenStore` versioned JSON-map reshape

**Files:**
- Modify: `PRism.Core/Auth/TokenStore.cs` — change `ReadAsync` and `CommitAsync` to (de)serialize the versioned-map JSON; add an internal `TokenCacheFile` record + load-path branching.
- Create: `tests/PRism.Core.Tests/Auth/TokenStoreReshapeTests.cs`.

**Spec:** § 4.3 (token cache shape + load-path priority branches).

**The wire shape:**

```jsonc
{ "version": 1, "tokens": { "default": "<pat>" } }
```

Load-path priority branches (per spec § 4.3 numbered list):
1. Empty / missing → no-op (Read returns null).
2. Parses as single string (legacy) → wrap + write-back.
3. Parses as `{"version": 1, "tokens": {…}}` → use it.
4. Parses as `{"version": >1, …}` → enter read-only mode; surface message.
5. Parses as `{"version": ≤0 / null / non-integer, …}` or other shape → parse-failure surface; no overwrite.
6. Fails to parse → parse-failure surface; no overwrite.

`ITokenStore` interface unchanged (`ReadAsync` returns `string?` — the PAT for the default account; multi-token JSON shape is internal).

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.Core.Tests/Auth/TokenStoreReshapeTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Auth;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Auth;

public class TokenStoreReshapeTests
{
    [Fact]
    public async Task ReadAsync_returns_null_when_cache_file_missing()
    {
        using var dir = new TempDataDir();
        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().BeNull();
    }

    [Fact]
    public async Task ReadAsync_unwraps_versioned_json_map_to_default_pat()
    {
        using var dir = new TempDataDir();
        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        await store.WriteTransientAsync("ghp_abc", CancellationToken.None);
        await store.CommitAsync(CancellationToken.None);

        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_abc");
        // On-disk shape is the versioned map.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"version\":1");
        raw.Should().Contain("\"default\":\"ghp_abc\"");
    }

    [Fact]
    public async Task ReadAsync_migrates_legacy_bare_pat_blob_to_versioned_map_on_first_read()
    {
        using var dir = new TempDataDir();
        // Write a legacy-shape cache: BARE PAT bytes — no surrounding quotes. This is what the
        // pre-S6-PR0 CommitAsync wrote via `Encoding.UTF8.GetBytes(_transient)` (TokenStore.cs:107
        // on `main` at HEAD 4c6ed08). The ce-doc-review feasibility + adversarial reviewers caught
        // that the original plan-draft fixture was JSON-quoted (`"\"ghp_legacy\""`), which does
        // NOT match real legacy bytes; testing with quoted bytes hid the migration bug.
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"), "ghp_legacy");

        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_legacy");

        // After the read, the cache is rewritten to the versioned shape.
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"version\":1");
        raw.Should().Contain("\"default\":\"ghp_legacy\"");
    }

    [Fact]
    public async Task ReadAsync_migrates_legacy_quoted_pat_blob_too_for_hand_edited_safety()
    {
        // Defensive: a curious admin who hand-edited PRism.tokens.cache might have JSON-quoted
        // the PAT. Both shapes should migrate cleanly. (This case rounds-trips through
        // JsonNode.Parse as JsonValue<string>, which the branch-2 detector also accepts.)
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"), "\"ghp_quoted_legacy\"");

        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);
        var pat = await store.ReadAsync(CancellationToken.None);

        pat.Should().Be("ghp_quoted_legacy");
        var raw = await File.ReadAllTextAsync(Path.Combine(dir.Path, "PRism.tokens.cache"));
        raw.Should().Contain("\"default\":\"ghp_quoted_legacy\"");
    }

    [Fact]
    public async Task ReadAsync_future_version_cache_throws_TokenStoreException_with_clear_message_and_does_not_overwrite()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        var original = "{\"version\":2,\"tokens\":{\"default\":\"ghp_future\"}}";
        await File.WriteAllTextAsync(path, original);

        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        Func<Task> act = () => store.ReadAsync(CancellationToken.None);

        var ex = await act.Should().ThrowAsync<TokenStoreException>();
        ex.Which.Failure.Should().Be(TokenStoreFailure.FutureVersionCache);
        ex.Which.Message.Should().Contain("downgraded");

        // The file is left intact — read-only mode never writes.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(original);
    }

    [Fact]
    public async Task CommitAsync_after_future_version_ReadAsync_refuses_to_overwrite_the_v2_cache()
    {
        // ce-doc-review security finding 2 + adversarial finding 7: a v1 binary that has seen a
        // future-version cache MUST refuse subsequent CommitAsync calls. Without this guard,
        // WriteTransient+Commit between a Setup retry would silently overwrite a v2 cache (and
        // destroy any v2-added second-account PAT). The state.json store has the analogous
        // IsReadOnlyMode flag; the token store needs parity.
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        var original = "{\"version\":2,\"tokens\":{\"default\":\"ghp_v2_default\",\"secondary\":\"ghp_v2_second\"}}";
        await File.WriteAllTextAsync(path, original);

        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        // ReadAsync sets the read-only flag.
        await store.Invoking(s => s.ReadAsync(CancellationToken.None))
            .Should().ThrowAsync<TokenStoreException>();

        // Now stage a new candidate token and try to commit. The guard must refuse.
        await store.WriteTransientAsync("ghp_v1_freshly_set", CancellationToken.None);
        Func<Task> commit = () => store.CommitAsync(CancellationToken.None);

        var commitEx = await commit.Should().ThrowAsync<TokenStoreException>();
        commitEx.Which.Failure.Should().Be(TokenStoreFailure.FutureVersionCache);

        // File still intact — v2 cache preserved.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(original);
    }

    [Theory]
    [InlineData("{\"version\":0,\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"version\":null,\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"version\":\"one\",\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("{\"tokens\":{\"default\":\"ghp_abc\"}}")]
    [InlineData("garbage-not-json")]
    public async Task ReadAsync_invalid_version_discriminator_throws_TokenStoreException_and_does_not_overwrite(string fileContents)
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "PRism.tokens.cache");
        await File.WriteAllTextAsync(path, fileContents);

        using var store = new TokenStore(dir.Path, useFileCacheForTests: true);

        Func<Task> act = () => store.ReadAsync(CancellationToken.None);

        var ex = await act.Should().ThrowAsync<TokenStoreException>();
        ex.Which.Failure.Should().Be(TokenStoreFailure.CorruptCache);

        // File preserved — surfacing "re-validate at Setup" must NOT overwrite.
        var raw = await File.ReadAllTextAsync(path);
        raw.Should().Be(fileContents);
    }
}
```

This test file references a `TokenStoreFailure.FutureVersionCache` enum member and `TokenStoreFailure.CorruptCache` — these must exist (add to `PRism.Core/Auth/TokenStoreException.cs` if missing; check first).

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~TokenStoreReshapeTests`
Expected: FAIL — the versioned-map round-trip test fails because `CommitAsync` currently writes raw UTF-8 bytes, the future-version branch doesn't throw, the corrupt-discriminator branch silently returns whatever string comes out of `Encoding.UTF8.GetString(bytes)`, etc.

- [ ] **Step 3: Extend `TokenStoreException` with new failure modes**

Modify `PRism.Core/Auth/TokenStoreException.cs` (read it first to confirm the enum's existing members; this is the expected post-state, adapt to the actual file structure):

```csharp
public enum TokenStoreFailure
{
    Generic,
    KeychainLibraryMissing,
    KeychainAgentUnavailable,
    FutureVersionCache,   // S6 PR0 — cache file's `version` field is greater than the binary's CurrentVersion
    CorruptCache,         // S6 PR0 — cache file is unparseable JSON, missing a usable `version`, or otherwise structurally invalid
}
```

If the enum already has values not shown, preserve them — append the two new entries.

- [ ] **Step 4: Implement the versioned-map (de)serialization in `TokenStore`**

Modify `PRism.Core/Auth/TokenStore.cs`. Add an internal `TokenCacheFile` record + the load-path branching:

```csharp
using System.Diagnostics.CodeAnalysis;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Identity.Client.Extensions.Msal;
using PRism.Core.State;

namespace PRism.Core.Auth;

public sealed class TokenStore : ITokenStore
{
    private const string CacheFileName = "PRism.tokens.cache";
    private const string ServiceName = "PRism";
    private const string AccountName = "github-pat";
    private const int CurrentVersion = 1;

    private readonly string _cacheDir;
    private readonly bool _useFileCacheForTests;
    private MsalCacheHelper? _helper;
    private string? _transient;
    private string? _transientLogin;

    // Parity with AppStateStore.IsReadOnlyMode: once ParseCacheFileBytes detects a future-version
    // cache, every subsequent CommitAsync refuses to write. Without this, the WriteTransient+Commit
    // path during a Setup retry would overwrite a v2 cache with a v1-shape map containing only the
    // "default" entry, silently destroying any v2-added per-account PATs. ce-doc-review security
    // finding 2 promoted this from the deferrals-sidecar P2 risk to a P0 enforced guard.
    private bool _isReadOnlyMode;

    public TokenStore(string dataDir, bool useFileCacheForTests = false)
    {
        _cacheDir = dataDir;
        _useFileCacheForTests = useFileCacheForTests;
    }

    public bool IsReadOnlyMode => _isReadOnlyMode;

    [SuppressMessage("Design", "CA1031:Do not catch general exception types",
        Justification = "Catch-all is intentional: any keychain failure must be mapped to TokenStoreFailure.Generic so callers see a uniform error surface.")]
    private async Task<MsalCacheHelper> GetHelperAsync()
    {
        // unchanged from current implementation — preserve the full body
        if (_helper is not null) return _helper;
        try
        {
            var props = new StorageCreationPropertiesBuilder(CacheFileName, _cacheDir);
            if (_useFileCacheForTests)
            {
                props.WithUnprotectedFile();
            }
            else
            {
                props
                    .WithMacKeyChain(serviceName: ServiceName, accountName: AccountName)
                    .WithLinuxKeyring(
                        schemaName: "com.prism.tokens",
                        collection: MsalCacheHelper.LinuxKeyRingDefaultCollection,
                        secretLabel: "PRism GitHub PAT",
                        attribute1: new KeyValuePair<string, string>("Service", ServiceName),
                        attribute2: new KeyValuePair<string, string>("Account", AccountName));
            }
            _helper = await MsalCacheHelper.CreateAsync(props.Build()).ConfigureAwait(false);
            return _helper;
        }
        catch (DllNotFoundException ex)
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainLibraryMissing,
                "OS keychain library not installed. Install libsecret-1 (apt install libsecret-1-0 / dnf install libsecret), then restart PRism.", ex);
        }
        catch (Exception ex) when (ex.Message.Contains("DBus", StringComparison.OrdinalIgnoreCase) || ex.Message.Contains("no provider", StringComparison.OrdinalIgnoreCase))
        {
            throw new TokenStoreException(TokenStoreFailure.KeychainAgentUnavailable,
                "OS keychain library is installed but no keyring agent is running. Start gnome-keyring-daemon or kwalletd, then restart PRism. Common on WSL and minimal sessions.", ex);
        }
        catch (Exception ex)
        {
            throw new TokenStoreException(TokenStoreFailure.Generic,
                $"OS keychain returned an error: {ex.Message}", ex);
        }
    }

    public async Task<bool> HasTokenAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync().ConfigureAwait(false);
        var bytes = helper.LoadUnencryptedTokenCache();
        return bytes.Length > 0;
    }

    public async Task<string?> ReadAsync(CancellationToken ct)
    {
        // Transient takes precedence (unchanged) so PAT validation between WriteTransientAsync and
        // Commit/Rollback sees the candidate token.
        if (_transient is not null) return _transient;

        var helper = await GetHelperAsync().ConfigureAwait(false);
        var bytes = helper.LoadUnencryptedTokenCache();
        if (bytes.Length == 0) return null;

        var raw = Encoding.UTF8.GetString(bytes);
        return ParseCacheFileBytes(raw, helper);
    }

    // Pre-S6-PR0 CommitAsync wrote raw PAT bytes (Encoding.UTF8.GetBytes(_transient)) — NOT JSON-
    // encoded. Real legacy cache contents look like `ghp_xxxxxxxxxxxxxx` (no surrounding quotes),
    // not `"ghp_xxxxxxxxxxxxxx"`. ce-doc-review caught that the original branch-2 heuristic
    // (`trimmed[0] == '"'`) only fired for hand-edited JSON-quoted caches, leaving every real
    // legacy user to fall through to CorruptCache on first read. The corrected detection: try
    // JsonNode.Parse first; if it returns a string-shaped JsonValue (hand-edited quoted form),
    // branch-2; if it throws AND the raw content matches a PAT-like character class, branch-2;
    // otherwise pass to the structural shape checks.
    private static readonly System.Text.RegularExpressions.Regex LegacyPatPattern =
        new(@"^[A-Za-z0-9_\-]{20,255}$", System.Text.RegularExpressions.RegexOptions.Compiled);

    private string ParseCacheFileBytes(string raw, MsalCacheHelper helper)
    {
        var trimmed = raw.Trim();

        // Branch 2 — Legacy single-PAT blob (the ONLY shape pre-S6-PR0 ever wrote on disk).
        // Two flavors to accept:
        //   (a) bare PAT bytes: `ghp_xxx...` — what the real pre-S6-PR0 binary wrote.
        //   (b) JSON-quoted PAT: `"ghp_xxx..."` — a hand-edited safety net.
        // Either shape: wrap as the versioned map and write back via MSAL (same protection level
        // as CommitAsync — keychain on desktop, WithUnprotectedFile only in test mode).
        JsonNode? parsedFirstPass = null;
        bool isBareLegacyPat = LegacyPatPattern.IsMatch(trimmed);
        if (!isBareLegacyPat)
        {
            try { parsedFirstPass = JsonNode.Parse(raw); }
            catch (JsonException) { /* fall through */ }
        }

        string? legacyPat = null;
        if (isBareLegacyPat)
        {
            legacyPat = trimmed;
        }
        else if (parsedFirstPass is JsonValue jv && jv.TryGetValue<string>(out var quoted) && !string.IsNullOrEmpty(quoted))
        {
            legacyPat = quoted;
        }
        if (legacyPat is not null)
        {
            var migrated = SerializeVersionedMap(legacyPat);
            helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(migrated));
            return legacyPat;
        }

        // Branches 3/4/5 — Versioned-map shape (or future-version, or invalid discriminator).
        // If parsedFirstPass threw above, re-throw the same path; otherwise reuse parsedFirstPass.
        JsonNode? root = parsedFirstPass;
        if (root is null)
        {
            try { root = JsonNode.Parse(raw); }
            catch (JsonException ex)
            {
                throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                    "PRism.tokens.cache is unparseable. Re-validate the PAT at Setup.", ex);
            }
        }
        if (root is not JsonObject obj)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache root must be a JSON object. Re-validate the PAT at Setup.");
        }
        var versionNode = obj["version"];
        if (versionNode is null)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache is missing the `version` discriminator. Re-validate the PAT at Setup.");
        }
        int version;
        try
        {
            version = versionNode.GetValue<int>();
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or OverflowException)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache `version` field is not an integer. Re-validate the PAT at Setup.", ex);
        }

        if (version < 1)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache `version` is {version}, which is not a recognized format. Re-validate the PAT at Setup.");
        }
        if (version > CurrentVersion)
        {
            // Branch 4 — future-version. Set read-only flag BEFORE throwing so CommitAsync also
            // refuses (parity with AppStateStore.IsReadOnlyMode). The file is preserved.
            _isReadOnlyMode = true;
            throw new TokenStoreException(TokenStoreFailure.FutureVersionCache,
                "PRism was downgraded; upgrade or wipe PRism.tokens.cache.");
        }

        // Branch 3 — versioned-map at the current version. Pluck the default account's PAT.
        var tokensNode = obj["tokens"];
        if (tokensNode is not JsonObject tokens)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                "PRism.tokens.cache `tokens` field is missing or not a JSON object. Re-validate the PAT at Setup.");
        }
        var defaultNode = tokens[AccountKeys.Default];
        if (defaultNode is null)
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache has no `tokens.{AccountKeys.Default}` entry. Re-validate the PAT at Setup.");
        }
        var pat = defaultNode.GetValue<string>();
        if (string.IsNullOrEmpty(pat))
        {
            throw new TokenStoreException(TokenStoreFailure.CorruptCache,
                $"PRism.tokens.cache `tokens.{AccountKeys.Default}` is empty. Re-validate the PAT at Setup.");
        }
        return pat;
    }

    private static string SerializeVersionedMap(string defaultPat)
    {
        var root = new JsonObject
        {
            ["version"] = CurrentVersion,
            ["tokens"] = new JsonObject
            {
                [AccountKeys.Default] = defaultPat
            }
        };
        return root.ToJsonString();
    }

    public Task WriteTransientAsync(string token, CancellationToken ct)
    {
        _transient = token;
        _transientLogin = null;
        return Task.CompletedTask;
    }

    public Task SetTransientLoginAsync(string login, CancellationToken ct)
    {
        _transientLogin = login;
        return Task.CompletedTask;
    }

    public Task<string?> ReadTransientLoginAsync(CancellationToken ct) => Task.FromResult(_transientLogin);

    public async Task CommitAsync(CancellationToken ct)
    {
        if (_transient is null) throw new InvalidOperationException("No transient token to commit.");
        if (_isReadOnlyMode)
        {
            // Once ReadAsync has seen a future-version cache, never overwrite. Setup-bypass for
            // recovery is "wipe PRism.tokens.cache" (surfaced via the FutureVersionCache message),
            // not a CommitAsync that destroys the v2 cache. Setup must catch this and refuse the
            // connect-flow rather than retrying transparently.
            throw new TokenStoreException(TokenStoreFailure.FutureVersionCache,
                "PRism was downgraded and the cache is in read-only mode. " +
                "Upgrade or wipe PRism.tokens.cache before connecting.");
        }
        var helper = await GetHelperAsync().ConfigureAwait(false);
        var payload = SerializeVersionedMap(_transient);
        helper.SaveUnencryptedTokenCache(Encoding.UTF8.GetBytes(payload));
        _transient = null;
        _transientLogin = null;
    }

    public Task RollbackTransientAsync(CancellationToken ct)
    {
        _transient = null;
        _transientLogin = null;
        return Task.CompletedTask;
    }

    public async Task ClearAsync(CancellationToken ct)
    {
        var helper = await GetHelperAsync().ConfigureAwait(false);
#pragma warning disable CS0618 // Type or member is obsolete
        helper.Clear();
#pragma warning restore CS0618
    }
}
```

A subtle point: `Encoding.UTF8.GetString(bytes)` returns the JSON literal `"<pat>"` (with surrounding quotes) for a legacy-blob cache. The branch-2 detection looks for a leading `"` *after trimming whitespace*. If the keychain wrapper has added any byte-order-mark or whitespace that fails this heuristic, branch 5 fires instead. Verify on a manual smoke against a real legacy cache file before merging.

- [ ] **Step 5: Run tests**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter FullyQualifiedName~TokenStoreReshapeTests`
Expected: PASS (legacy migration, versioned round-trip, future-version, 5 corrupt-discriminator inline-data rows).

Run: `dotnet test`
Expected: PASS — every existing `TokenStore` test continues to pass because `CommitAsync` writes the versioned shape and `ReadAsync` unwraps it. Any test that pinned the raw-bytes shape of the cache file (e.g., a test asserting `Encoding.UTF8.GetString(bytes) == "ghp_..."`) needs updating to assert the versioned-map shape.

- [ ] **Step 6: Commit**

```bash
git add PRism.Core/Auth/TokenStore.cs \
        PRism.Core/Auth/TokenStoreException.cs \
        tests/PRism.Core.Tests/Auth/TokenStoreReshapeTests.cs
git commit -m "feat(s6-pr0): reshape token cache to versioned JSON map with version-discriminator branches"
```

---

### Task 9: Update project-standards documentation (spec § 10)

**Files:**
- Modify: `docs/spec/02-architecture.md` — three sub-section amendments.
- Modify: `docs/spec/05-non-goals.md` — multi-host concurrency row.
- Modify: `docs/roadmap.md` — S6 row prefix.

**Spec:** § 10 (project standards updates).

This task has no associated test code — it's pure documentation work. Each amendment is a precise sentence-level edit per the spec.

- [ ] **Step 0: Verify target sections exist before amending**

Open `docs/spec/02-architecture.md` and confirm these sections exist (headings may not match the spec's exact wording):

- A section discussing the GitHub config shape (likely titled "GitHub host configuration", "Configuration", or similar; search for `github.host` in the file).
- A section documenting the "one host per launch" constraint (search for `one host`).
- A section describing the `LastConfiguredGithubHost` modal logic or host-change resolution (search for `LastConfiguredGithubHost` or `host-change`).

For `docs/spec/05-non-goals.md`: confirm a "Multi-host concurrency" row exists.

For `docs/roadmap.md`: confirm an S6 row exists.

If any section is missing or the heading has drifted from spec § 10's mental model, capture the gap in the deferrals sidecar before proceeding — don't invent amendments against the wrong heading.

- [ ] **Step 1: `docs/spec/02-architecture.md` § "GitHub host configuration"**

Find the section heading `## GitHub host configuration` (or similar — search `docs/spec/02-architecture.md` for `github.host`). Amend the paragraph that describes the canonical config shape:

```
Before: "...the canonical config shape is `github.host: <url>`..."
After:  "...the canonical config shape is `github.accounts: [{...}]` (a list of per-account
        entries; v1 always has one entry under `id: "default"`, and the runtime is
        single-account). v2's slice introduces additional entries when the multi-account
        runtime + UX lands. The C# property `AppConfig.Github.Host` is preserved as a
        delegate over `Accounts[0].Host` for v1 read-site compatibility."
```

Use the exact wording in the surrounding section's voice — match the prose register of the file.

- [ ] **Step 2: `docs/spec/02-architecture.md` § "one host per launch" constraint**

Find the section that documents the "one host per launch" architectural constraint. Append a note:

```
"As of S6 PR0, the constraint holds for v1 runtime (one active host, one PAT in scope)
but the on-disk storage shape scaffolds multiple accounts for v2's multi-account work
(see `docs/specs/2026-05-10-multi-account-scaffold-design.md`). The constraint is
amended, not lifted — v1 still loads one host into DI at startup."
```

- [ ] **Step 3: `docs/spec/02-architecture.md` § "Changing `github.host` between launches"**

Find the section describing the `LastConfiguredGithubHost` modal logic. Add a sentence:

```
"As of S6 PR0, `LastConfiguredGithubHost` lives under `state.json` at
`accounts.default.last-configured-github-host`; the C# delegate property
`AppState.LastConfiguredGithubHost` preserves the existing access pattern. The
modal logic and host-change-resolution endpoint are unchanged."
```

- [ ] **Step 4: `docs/spec/05-non-goals.md` "Multi-host concurrency" row**

Find the row labeled "Multi-host concurrency" (the exact label may differ — search `multi-host`). Update its description:

```
Before: "Multi-host concurrency: not supported in PoC."
After:  "Multi-host concurrency: storage shape scaffolded in v1 (S6 PR0); runtime + UX
        in v2 (multi-account brainstorm pending)."
```

- [ ] **Step 5: `docs/roadmap.md` S6 row**

Find the S6 row in the roadmap. Add `S6 PR0 — multi-account storage-shape scaffold` to the front of S6's PR sequence (before whatever the first existing S6 PR is — typically `PR1 — Settings page`).

Format match: copy whatever bullet/dash style the existing S6 row uses. If the row is a single-line summary, expand it to a sub-list of PRs (peek at S5's row for the precedent).

- [ ] **Step 6: Sanity-check no other doc references stale shape**

Run: `git grep -n 'github.host\b' docs/`

Each hit should be either (a) in a quoted JSON example that's been updated to the new shape, (b) prose that documents the V3→V4 history (acceptable — historical), or (c) a stale reference that needs updating. Update any (c).

- [ ] **Step 7: Commit**

```bash
git add docs/spec/02-architecture.md docs/spec/05-non-goals.md docs/roadmap.md
git commit -m "docs(s6-pr0): amend architecture + non-goals + roadmap for storage-shape scaffold"
```

---

### Task 10: Pre-push checklist + open the PR

**Spec:** none — this task enforces the standing user rule.

- [ ] **Step 1: Run the full pre-push checklist**

Per `.ai/docs/development-process.md`, run every step in order, foreground only, ≥300000ms timeout:

```bash
# 1. .NET build (no warnings allowed; project enables TreatWarningsAsErrors)
dotnet build PRism.sln --no-incremental

# 2. .NET tests (whole solution)
dotnet test PRism.sln

# 3. Frontend lint (mandatory even for backend-only PRs — TS types may have drifted)
npm --prefix frontend run lint

# 4. Frontend build (same rationale)
npm --prefix frontend run build
```

Expected: all four green.

- [ ] **Step 2: Manual smoke against a legacy fixture**

Stage a manual end-to-end migration to verify the on-disk shapes:

1. Create a temp data dir: `mkdir /tmp/prism-s6-pr0-smoke`.
2. Seed it with a V4 `state.json`, a legacy `config.json` (`github.host` shape), and a legacy single-string token cache:
   ```
   /tmp/prism-s6-pr0-smoke/state.json:   "version": 4 root with reviews/ai-state/last-configured-github-host
   /tmp/prism-s6-pr0-smoke/config.json:  { "github": { "host": "https://github.com", "local-workspace": null } }
   /tmp/prism-s6-pr0-smoke/PRism.tokens.cache:  "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
   ```
3. Launch PRism with `--data-dir /tmp/prism-s6-pr0-smoke`.
4. Verify after first launch:
   - `state.json` has `"version": 5` and `accounts.default.{reviews,ai-state,last-configured-github-host}`.
   - `config.json` has `github.accounts: [{"id":"default", ...}]`.
   - `PRism.tokens.cache` has `{"version":1, "tokens":{"default":"ghp_xxx..."}}`.
5. Verify the inbox still polls and shows `@me`-attributed PRs against `https://github.com`.

If any step fails: capture the failure mode in the deferrals sidecar before opening the PR.

- [ ] **Step 3: Open the PR**

Use the GitHub CLI:

```bash
gh pr create \
  --title "feat(s6-pr0): multi-account storage-shape scaffold (state V5, config accounts list, versioned token cache)" \
  --body "$(cat <<'EOF'
## Summary

S6 PR0 — storage-only scaffold ahead of the v2 multi-account brainstorm. v1 runtime is unchanged; on-disk shapes for `state.json`, `config.json`, and the token cache are reshaped to the multi-account-friendly layout so v2 ships against data already in that shape.

Spec: `docs/specs/2026-05-10-multi-account-scaffold-design.md`
Plan: `docs/plans/2026-05-10-multi-account-scaffold.md`
Deferrals: `docs/specs/2026-05-10-multi-account-scaffold-deferrals.md`

## Changes

- **State V4 → V5 migration** moves `Reviews` / `AiState` / `LastConfiguredGithubHost` under `accounts.default`. Delegate read properties preserve every existing `state.Reviews` / `state.AiState` / `state.LastConfiguredGithubHost` call site. New `WithDefaultReviews` / `WithDefaultAiState` / `WithDefaultLastConfiguredGithubHost` helpers replace `state with { Reviews = ... }` write patterns across 9 production sites.
- **Config rewrite**: `github.host: string` → `github.accounts: [{ "id", "host", "login", "local-workspace" }]`. `AppConfig.Github.Host` / `LocalWorkspace` preserved as delegates over `Accounts[0]`.
- **Token cache**: legacy single-string blob → `{ "version": 1, "tokens": { "default": "<pat>" } }` with a version-discriminator load path (future-version → read-only mode error; corrupt → re-validate at Setup with no overwrite).
- **`ViewerLoginHydrator`** now writes the validated login into `config.github.accounts[0].login` via new `IConfigStore.SetDefaultAccountLoginAsync`.

## Non-goals (deferred to v2)

No interface changes (`ITokenStore`, `IReviewService`, `IAppStateStore` keep their v1 signatures). No wire-shape changes. No middleware / SSE / frontend changes. v1 user-visible behavior is byte-identical.

## Verification

- `dotnet build` clean, `dotnet test` green (added: AccountKeysTests, AccountStateTests, AppStateWithDefaultHelpersTests, AppStateMigrationsV4ToV5Tests, GithubConfigDelegatesTests, ConfigStoreMigrationTests, ViewerLoginHydratorConfigWriteTests, TokenStoreReshapeTests).
- `npm run lint` + `npm run build` (frontend) green.
- Manual end-to-end smoke against a V4 `state.json` + legacy `config.json` + legacy token cache — all three migrate on first launch; inbox still polls against `https://github.com`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

After the PR is opened, surface the URL back to the user; do NOT merge — the user reviews and merges.

- [ ] **Step 4: Commit the deferrals sidecar updates**

Anything captured in the deferrals sidecar during implementation (decisions, surprises, drift caught in the smoke test) gets committed before opening the PR — re-run from Step 1 if any new commit lands.

```bash
git add docs/specs/2026-05-10-multi-account-scaffold-deferrals.md
git commit -m "docs(s6-pr0): record implementation-time decisions in deferrals sidecar"
```

(If the sidecar was untouched during implementation, skip this step.)

---

## Self-review

Per the writing-plans skill, I checked the plan against the spec with fresh eyes.

**Spec coverage:**

| Spec § | Requirement | Plan task |
|---|---|---|
| § 1 | Storage shape reshape; v2-friendly on-disk; v1 user-visible delta zero | Whole plan |
| § 2 in-scope 1 | V4→V5 state migration | Task 4 |
| § 2 in-scope 2 | `AppState` reshape + delegate reads + `WithDefault*` writes | Tasks 2 + 3 |
| § 2 in-scope 3 | Config `github.accounts` rewrite | Tasks 5 + 6 |
| § 2 in-scope 4 | Token cache versioned-map reshape | Task 8 |
| § 2 in-scope 5 | Token migration on first load | Task 8 (legacy-blob branch) |
| § 2 in-scope 6 | `AccountKey` as string constant | Task 1 |
| § 2 in-scope 7 | First-launch initialization (host default to github.com) | Task 6 (fresh-install test) |
| § 2 in-scope 8 | `"default"` key as permanent fixture | Tasks 1 + 4 (no rekey logic) |
| § 3 | `AccountKey` identity | Task 1 |
| § 4.1 | State schema V4→V5 + record reshape + caller migration | Tasks 2 + 3 + 4 |
| § 4.2 | Config schema rewrite + `Login` write-back | Tasks 5 + 6 + 7 |
| § 4.3 | Token store load-path branches | Task 8 |
| § 5 | No interface changes in v1 | Whole plan (verified via existing-test green bar) |
| § 6 | No wire changes in v1 | Whole plan (no SSE / endpoint contract task) |
| § 7 binding 1 | `accountKey` arbitrary opaque string | Task 1 (string const, no validation in v1 since hardcoded) |
| § 7 binding 5 | Version-bump discipline | Task 4 (V5 bump) + Task 8 (token cache version 1) |
| § 8 | Risks | Captured in the deferrals sidecar (V4→V5 vs V5→V6 cost discussion is forward-looking only) |
| § 9.1 | Migration tests | Tasks 4, 6, 8 |
| § 9.2 | Backwards-compat tests | Tasks 3 (read delegate test) + 5 (`GithubConfig` delegate test) |
| § 9.3 | No interface-boundary tests | Whole plan (none authored) |
| § 10 | Project standards updates | Task 9 |
| § 11 | Open question on delegate properties | Plan-time decision 3 + Task 3 (no `[Obsolete]` attribute) |

No gaps found.

**Placeholder scan:**

No `TBD` / `implement later` / `add appropriate error handling` / "similar to Task N" placeholders. Every code block contains the actual code an engineer types. The "if a helper doesn't exist, build a minimal one" pointer in Task 7 step 1 includes the actual code for `InMemoryViewerLoginProvider`; the `FakeTokenStore` / `FakeReviewAuth` references say to mirror existing patterns rather than spelling them out, which is a soft placeholder — acceptable here because the existing fakes likely exist (the test file imports `PRism.Core.Tests.TestHelpers`).

**Type consistency:**

- `AccountKeys.Default` is used consistently (Task 1 creates it, Tasks 2, 3, 6, 7, 8 reference `AccountKeys.Default`).
- `AppState.WithDefaultReviews` / `WithDefaultAiState` / `WithDefaultLastConfiguredGithubHost` method names are stable across Tasks 3, 4 (test references), and the production rewrites in Task 3 step 4.
- `IConfigStore.SetDefaultAccountLoginAsync(string, CancellationToken)` signature is stable across Tasks 7 (definition, implementation, call site).
- `TokenStoreFailure.FutureVersionCache` / `CorruptCache` enum members are referenced in Task 8 step 1 test and defined in step 3.
- `MigrateV4ToV5` method name is consistent: Task 4 step 1 test calls `AppStateMigrations.MigrateV4ToV5`; step 3 defines it under `AppStateMigrations`; step 4 wires it into `MigrationSteps` as `(5, AppStateMigrations.MigrateV4ToV5)`.

No drift.
