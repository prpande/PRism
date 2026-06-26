# PR Lifecycle Actions — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the reusable GitHub PR write-path foundation plus Close / Reopen / Mark-ready-for-review / Convert-to-draft, surfaced in an adaptive bottom-sticky panel in the Overview tab.

**Architecture:** A new `IPrLifecycleWriter` (impl `GitHubPrLifecycleWriter`) performs the GitHub writes (REST `PATCH …/pulls/{n}` for close/reopen; GraphQL `markPullRequestReadyForReview`/`convertPullRequestToDraft` for draft toggles, keyed by a GraphQL-resolved node id). Four `POST` endpoints gate on `RequireSubscribed` + the `X-PRism-Tab-Id` custom header, call the writer, classify failures into typed codes, and on success publish a new `PrLifecycleChanged` bus event. That event evicts the head-SHA-keyed snapshot (`PrDetailLoader.Invalidate`) and fans out over SSE; a new `useLifecycleChangedSubscriber` (mounted in `PrDetailView`) reloads PR detail. The frontend uses a `usePrAction` hook (pending-state-then-reconcile, synchronous re-entrancy guard, observed-target-state-gated ~5s fallback) and a state-aware `PrActionsPanel` mounted as a full-width footer of a newly-split Overview DOM.

**Tech Stack:** .NET 10 (PRism.Core / PRism.Core.Contracts / PRism.GitHub / PRism.Web), React 18 + Vite + TypeScript, vitest + Testing Library, xUnit + FluentAssertions.

**Spec:** `docs/specs/2026-06-26-pr-lifecycle-actions-slice1-design.md` (ce-doc-review rounds 1–2 applied).

## Global Constraints

- **No GET DTO wire-shape change.** The panel reads existing `PrDetailDto.Pr` fields (`State`, `IsDraft`, `IsClosed`, `IsMerged`). No field added to any GET DTO.
- **CSRF parity:** all four lifecycle `POST`s require a present, allowlist-conforming `X-PRism-Tab-Id` header (`TabStamps.TabIdHeader`, `PrDetailEndpoints.TabIdAllowlistRegex()`), same as `…/submit`.
- **DI:** register `IPrLifecycleWriter` in `AddPrismGitHub` (PRism.GitHub), mirroring the `IReviewSubmitter` registration (`GetRequiredService<ILogger<…>>`, late-bound host + token closure) — **not** `AddPrismCore`.
- **Server-side log before sanitize:** every classified GitHub failure is logged (with truncated body) at Warning before the sanitized DTO returns (mirror `s_ownDiscardGitHubFailed`).
- **Error codes (the FE↔BE contract, kebab-case in JSON):** `token-cannot-write`, `repo-rule-blocked`, `reopen-not-possible`, `plan-unsupported-drafts`, `rate-limited`, `generic`. Plus the subscribe-rejection from the `RequireSubscribed` guard (its existing status). "Already ready" / "already a draft" GraphQL errors are **benign no-ops** (success, no toast).
- **Token-cannot-write copy is a single combined string** (no runtime token-kind detection): names classic `repo` scope + fine-grained "Pull requests: Read and write" + the non-collaborator caveat.
- **Pre-push checklist** (`.ai/docs/development-process.md`): `dotnet build` + `dotnet test`; `npm run lint`; `npm test`; `tsc -b` (not `--noEmit`); prettier `--write` new FE files before staging.
- **Tests:** backend co-located under `tests/PRism.*.Tests/`; FE hook tests co-located `frontend/src/hooks/*.test.ts`; FE component tests under `frontend/__tests__/`.

## Reconcile / fallback signal (recorded per "document plan deviations durably")

The spec said pass `usePrDetail`'s "reload counter" into `usePrAction`. `usePrDetail` exposes no counter. Round 1 of this plan used **`prDetail` object identity** as the signal; round 2 of the plan ce-doc-review (adversarial) showed that is **wrong under concurrency**: `prDetail` identity is advanced by *six* unrelated reload triggers in `PrDetailView` (root/single comment posted, draft submitted, activation transition, auto-transition). An unrelated reload landing in the post-window would silently disarm the SSE-drop fallback — exactly in the dropped-SSE case the fallback exists for — leaving the panel on the stale button set.

So this plan uses the **observed PR lifecycle state reaching the action's target** as the reconcile signal instead: after `close` the fallback is satisfied only when `isClosed` is observed true; after `reopen` when `isClosed` is false; after `ready` when the PR is open and non-draft; after `convert-to-draft` when it is open and draft. An unrelated reload that does *not* reach the target leaves the fallback armed (correct); the action's own reconcile reload (SSE-driven or fallback) flips the state and cancels it. This is strictly more robust than identity, distinguishes the action's own reload from any other, and drops the dependence on `setData` always minting a fresh object. **Residual (round-2 adversarial finding A3):** `usePrDetail` only `setData`s on GET *success*, so a reconcile GET that errors leaves the observed state stale — the fallback fires once more, and a *persistent* GET failure surfaces through the existing detail-error path rather than a silently stale panel. Rationale logged here; mirror it in the implementing commit message.

## File Structure

**Backend — create:**
- `PRism.Core/IPrLifecycleWriter.cs` — interface + `PrLifecycleResult` + `PrLifecycleErrorCode`.
- `PRism.GitHub/GitHubPrLifecycleWriter.cs` — implementation (writes + classification + node-id resolve).
- `PRism.Web/Endpoints/PrLifecycleEndpoints.cs` — four POSTs.
- `tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs`
- `tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs`
- `tests/PRism.Web.Tests/Sse/SseChannelPrLifecycleTests.cs`
- `tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs` (+ a `TestPrLifecycleWriter` fake)

**Backend — modify:**
- `PRism.Core/Events/SubmitBusEvents.cs` — add `PrLifecycleChanged` record.
- `PRism.Core/PrDetail/PrDetailLoader.cs` — subscribe/handle/dispose for the new event.
- `PRism.Web/Sse/SseChannel.cs` — subscribe/handler/dispose.
- `PRism.Web/Sse/SseEventProjection.cs` — wire record + projection arm.
- `PRism.GitHub/ServiceCollectionExtensions.cs` — DI registration.
- `PRism.Web/Program.cs` (or wherever endpoint groups are mapped) — map `PrLifecycleEndpoints`.

**Frontend — create:**
- `frontend/src/api/prLifecycle.ts` — client fns + error-code type.
- `frontend/src/hooks/useLifecycleChangedSubscriber.ts`
- `frontend/src/hooks/usePrAction.ts`
- `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` (+ `.module.css`)
- `frontend/src/hooks/usePrAction.test.ts`
- `frontend/src/hooks/useLifecycleChangedSubscriber.test.ts`
- `frontend/__tests__/PrActionsPanel.test.tsx`

**Frontend — modify:**
- `frontend/src/api/types.ts` — add the `PrLifecycleChangedEvent` payload type.
- `frontend/src/api/events.ts` — register `'pr-lifecycle-changed'` in `EventPayloadByType` **and** the `EVENT_TYPES` runtime array.
- `frontend/src/hooks/usePrDetail.ts` — (no change needed; `reload` already exported; the reconcile signal is the observed `prState`, not a usePrDetail field).
- `frontend/src/components/PrDetail/prDetailContext.tsx` — add `reload` to context value + types.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — wire `useLifecycleChangedSubscriber`; pass `reload` into context.
- `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` + `.module.css` — DOM split + mount panel.
- `frontend/src/components/PrDetail/testUtils.tsx` — add `reload` default to `makePrDetailContextValue`.

---

## Task 1: `PrLifecycleChanged` bus event

**Files:**
- Modify: `PRism.Core/Events/SubmitBusEvents.cs`

**Interfaces:**
- Produces: `public sealed record PrLifecycleChanged(PrReference PrRef) : IReviewEvent` — consumed by `PrDetailLoader`, `SseChannel`, `SseEventProjection`, `PrLifecycleEndpoints`.

> **No standalone test for this record** (plan ce-doc-review — scope-guardian): a `record` with a primary-ctor param guarantees field round-trip, and `: IReviewEvent` is compiler-enforced — a dedicated test would assert only what the compiler already guarantees. The record is meaningfully exercised by the `PrDetailLoader` eviction test (Task 5) and the SSE projection/fan-out tests (Task 6). This task is a single mechanical add, folded into the next testable deliverable's history.

- [ ] **Step 1: Add the record**

In `PRism.Core/Events/SubmitBusEvents.cs`, after the `SingleCommentPostedBusEvent` record (around line 55), add:

```csharp
// #566 — published after a successful PR lifecycle write (close / reopen / mark-ready /
// convert-to-draft). Like a comment post, a lifecycle change moves no head SHA, so the
// (prRef, headSha, generation) snapshot key would re-serve stale detail; the matching
// PrDetailLoader subscription evicts on this event. Fans out per-PR over SSE so the acting
// tab (and any peer tab on the PR) reloads. prRef only — the FE just needs the reload signal.
public sealed record PrLifecycleChanged(PrReference PrRef) : IReviewEvent;
```

- [ ] **Step 2: Build to verify it compiles**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' build PRism.Core`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/Events/SubmitBusEvents.cs
git commit -m "feat(#566): add PrLifecycleChanged bus event"
```

---

## Task 2: `IPrLifecycleWriter` interface + result types

**Files:**
- Create: `PRism.Core/IPrLifecycleWriter.cs`
- Test: (covered by Task 3's writer tests — no standalone test for a pure interface/record; the records are exercised there)

**Interfaces:**
- Produces:
  - `enum PrLifecycleErrorCode { None, TokenCannotWrite, RepoRuleBlocked, ReopenNotPossible, PlanUnsupportedDrafts, RateLimited, Generic }`
  - `sealed record PrLifecycleResult(bool Success, PrLifecycleErrorCode ErrorCode)` with `PrLifecycleResult.Ok` and `PrLifecycleResult.Fail(code)`.
  - `interface IPrLifecycleWriter` — `CloseAsync` / `ReopenAsync` / `MarkReadyForReviewAsync` / `ConvertToDraftAsync`, each `(PrReference, CancellationToken) → Task<PrLifecycleResult>`.

- [ ] **Step 1: Create the interface file**

```csharp
// PRism.Core/IPrLifecycleWriter.cs
using PRism.Core.Contracts;

namespace PRism.Core;

// #566 — the GitHub PR lifecycle write surface (slice 1: the optionless state actions).
// Kept separate from IReviewSubmitter (lifecycle actions are not reviews) so the review
// fakes don't grow irrelevant methods. Slice 2 adds merge to this same seam; #571 mirrors
// the pattern on its own interface for thread resolve/unresolve.
public interface IPrLifecycleWriter
{
    // REST PATCH /repos/{o}/{r}/pulls/{n} { "state": "closed" }.
    Task<PrLifecycleResult> CloseAsync(PrReference reference, CancellationToken ct);

    // REST PATCH /repos/{o}/{r}/pulls/{n} { "state": "open" }. 422 (deleted head branch)
    // surfaces as ReopenNotPossible.
    Task<PrLifecycleResult> ReopenAsync(PrReference reference, CancellationToken ct);

    // GraphQL markPullRequestReadyForReview (node-id keyed). An "already ready" error is a
    // benign no-op (returns Ok).
    Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference reference, CancellationToken ct);

    // GraphQL convertPullRequestToDraft (node-id keyed). An "already a draft" error is a benign
    // no-op (returns Ok); a plan-without-drafts failure surfaces as PlanUnsupportedDrafts.
    Task<PrLifecycleResult> ConvertToDraftAsync(PrReference reference, CancellationToken ct);
}

// Why an error code (not an exception or a bare bool): the endpoint maps the cause to the right
// HTTP status + the FE maps it to actionable copy. See the spec's error-handling section.
public enum PrLifecycleErrorCode
{
    None,
    TokenCannotWrite,      // scope/permission denial OR non-collaborator (GitHub uses one body)
    RepoRuleBlocked,       // branch-protection / policy block — do NOT advise changing the PAT
    ReopenNotPossible,     // reopen 422 (head branch/repo deleted)
    PlanUnsupportedDrafts, // convert-to-draft on a plan without draft PRs
    RateLimited,           // secondary rate-limit / abuse — transient/retry, never token-cannot-write
    Generic,               // anything else
}

public sealed record PrLifecycleResult(bool Success, PrLifecycleErrorCode ErrorCode)
{
    public static PrLifecycleResult Ok { get; } = new(true, PrLifecycleErrorCode.None);
    public static PrLifecycleResult Fail(PrLifecycleErrorCode code) => new(false, code);
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' build PRism.Core`
Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add PRism.Core/IPrLifecycleWriter.cs
git commit -m "feat(#566): add IPrLifecycleWriter interface + result types"
```

---

## Task 3: `GitHubPrLifecycleWriter` implementation

**Files:**
- Create: `PRism.GitHub/GitHubPrLifecycleWriter.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs`

**Interfaces:**
- Consumes: `IPrLifecycleWriter`, `PrLifecycleResult`, `PrLifecycleErrorCode` (Task 2); `GitHubGraphQL.PostAsync`, `GitHubHttp.SendAsync`, `GitHubHttp.Truncate`, `GitHubHttp.ReadErrorBodyBestEffortAsync`, `HostUrlResolver` (existing internal transport).
- Produces: `internal sealed class GitHubPrLifecycleWriter : IPrLifecycleWriter` (constructed exactly like `GitHubReviewSubmitter`).

> **Note on transport:** `GitHubReviewSubmitter`'s `PostGraphQLAsync`/`SendGitHubAsync` are private instance wrappers — not shareable. Copy the same thin wrappers over the shared `internal static` `GitHubGraphQL.PostAsync` / `GitHubHttp.SendAsync` (the established "verbatim twin" pattern). **Build the pulls URL as a BARE-RELATIVE path** (`repos/{o}/{r}/pulls/{n}`) resolved against the named `github` client's `BaseAddress`, exactly as `GitHubReviewSubmitter.IssueComments.cs` does — do **NOT** prepend `api/v3/`. (Plan ce-doc-review — adversarial: `/api/v3` is the **GHES** path; on dotcom the base is `https://api.github.com/`, so prepending it double-prefixes → 404. The test's `BaseAddress` happens to be the GHES form, but the bare-relative URL is correct against either base.)

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs
using System.Net;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubPrLifecycleWriterTests
{
    private static readonly PrReference Pr = new("o", "r", 1);

    // A stub HttpMessageHandler that returns queued responses and records requests.
    private sealed class StubHandler : HttpMessageHandler
    {
        private readonly Queue<HttpResponseMessage> _responses;
        public List<(HttpMethod Method, string Url, string? Body)> Requests { get; } = new();
        public StubHandler(params HttpResponseMessage[] responses) => _responses = new(responses);
        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(ct);
            Requests.Add((request.Method, request.RequestUri!.ToString(), body));
            return _responses.Dequeue();
        }
    }

    private static IHttpClientFactory FactoryFor(StubHandler handler)
    {
        var client = new HttpClient(handler) { BaseAddress = new Uri("https://api.github.com/api/v3/") };
        var factory = new Moq.Mock<IHttpClientFactory>();
        factory.Setup(f => f.CreateClient(It.IsAny<string>())).Returns(client);
        return factory.Object;
    }

    private static GitHubPrLifecycleWriter MakeWriter(StubHandler handler) =>
        new(FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com", NullLogger<GitHubPrLifecycleWriter>.Instance);

    private static HttpResponseMessage Resp(HttpStatusCode code, string body = "{}") =>
        new(code) { Content = new StringContent(body) };

    [Fact]
    public async Task CloseAsync_issues_PATCH_state_closed_and_returns_Ok()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK));
        var writer = MakeWriter(handler);

        var result = await writer.CloseAsync(Pr, CancellationToken.None);

        result.Should().Be(PrLifecycleResult.Ok);
        handler.Requests.Should().ContainSingle();
        handler.Requests[0].Method.Should().Be(HttpMethod.Patch);
        handler.Requests[0].Url.Should().EndWith("/repos/o/r/pulls/1");
        handler.Requests[0].Body.Should().Contain("\"state\":\"closed\"");
    }

    [Fact]
    public async Task ReopenAsync_issues_PATCH_state_open()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.OK));
        var result = await MakeWriter(handler).ReopenAsync(Pr, CancellationToken.None);
        result.Success.Should().BeTrue();
        handler.Requests[0].Body.Should().Contain("\"state\":\"open\"");
    }

    [Fact]
    public async Task CloseAsync_403_resource_not_accessible_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Resource not accessible by personal access token\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
    }

    [Fact]
    public async Task CloseAsync_403_protected_branch_maps_to_RepoRuleBlocked()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Protected branch update failed\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RepoRuleBlocked);
    }

    [Fact]
    public async Task ReopenAsync_422_maps_to_ReopenNotPossible()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.UnprocessableEntity,
            "{\"message\":\"Validation Failed\",\"errors\":[{\"resource\":\"PullRequest\",\"field\":\"base\"}]}"));
        var result = await MakeWriter(handler).ReopenAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.ReopenNotPossible);
    }

    [Fact]
    public async Task MarkReadyForReviewAsync_resolves_node_id_then_runs_mutation()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"data\":{\"markPullRequestReadyForReview\":{\"pullRequest\":{\"isDraft\":false}}}}"));
        var result = await MakeWriter(handler).MarkReadyForReviewAsync(Pr, CancellationToken.None);
        result.Success.Should().BeTrue();
        handler.Requests.Should().HaveCount(2); // resolve + mutate
        handler.Requests[1].Body.Should().Contain("markPullRequestReadyForReview");
        handler.Requests[1].Body.Should().Contain("PR_node1");
    }

    [Fact]
    public async Task ConvertToDraftAsync_already_draft_is_benign_noop_Ok()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"errors\":[{\"message\":\"Pull request is already a draft\"}]}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.Should().Be(PrLifecycleResult.Ok);
        // Plan ce-doc-review round 2 (scope): pin the mutation body too — the spec requires
        // "each of the four actions issues the correct GraphQL call", not just the Ok outcome.
        handler.Requests.Should().HaveCount(2); // resolve + mutate
        handler.Requests[1].Body.Should().Contain("convertPullRequestToDraft");
        handler.Requests[1].Body.Should().Contain("PR_node1");
    }

    [Fact]
    public async Task ConvertToDraftAsync_plan_unsupported_maps_to_PlanUnsupportedDrafts()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.OK, "{\"errors\":[{\"message\":\"Draft pull requests are not supported in this repository\"}]}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.PlanUnsupportedDrafts);
    }

    [Fact]
    public async Task CloseAsync_429_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.TooManyRequests, "{\"message\":\"rate limited\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review (adversarial): a 403 PRIMARY rate-limit body has neither "secondary"
    // nor "abuse" — it must still map to RateLimited, not TokenCannotWrite.
    [Fact]
    public async Task CloseAsync_403_primary_rate_limit_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"API rate limit exceeded for user ID 1.\"}"));
        var result = await MakeWriter(handler).CloseAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review (feasibility + adversarial): the GraphQL mutation throws on non-2xx;
    // a 401 on the mutation hop must map to TokenCannotWrite, NOT escape as an unhandled 500.
    [Fact]
    public async Task MarkReadyForReviewAsync_mutation_401_maps_to_TokenCannotWrite()
    {
        var handler = new StubHandler(
            Resp(HttpStatusCode.OK, "{\"data\":{\"repository\":{\"pullRequest\":{\"id\":\"PR_node1\"}}}}"),
            Resp(HttpStatusCode.Unauthorized, "{\"message\":\"Bad credentials\"}"));
        var result = await MakeWriter(handler).MarkReadyForReviewAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
    }

    // A 429 on the node-id RESOLVE hop keeps its RateLimited meaning (not blanket Generic).
    [Fact]
    public async Task ConvertToDraftAsync_resolve_429_maps_to_RateLimited()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.TooManyRequests, "{\"message\":\"rate limited\"}"));
        var result = await MakeWriter(handler).ConvertToDraftAsync(Pr, CancellationToken.None);
        result.ErrorCode.Should().Be(PrLifecycleErrorCode.RateLimited);
    }

    // Plan ce-doc-review round 2 (scope): the spec requires asserting the classified failure is
    // LOGGED server-side (truncated body) BEFORE the sanitized DTO returns — the other tests wire
    // NullLogger and never check this half. This is the only test that captures the log.
    [Fact]
    public async Task A_classified_failure_logs_the_github_body_server_side()
    {
        var handler = new StubHandler(Resp(HttpStatusCode.Forbidden,
            "{\"message\":\"Resource not accessible by personal access token\"}"));
        var log = new CapturingLogger<GitHubPrLifecycleWriter>();
        var writer = new GitHubPrLifecycleWriter(
            FactoryFor(handler), () => Task.FromResult<string?>("ghp_token"), "https://api.github.com", log);

        var result = await writer.CloseAsync(Pr, CancellationToken.None);

        result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
        log.Entries.Should().ContainSingle()
            .Which.Should().Contain("Resource not accessible"); // the raw GitHub body reaches the LOG, not the DTO
    }

    // Minimal ILogger<T> that records formatted entries (no external test-logging package needed).
    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Entries { get; } = new();
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Entries.Add(formatter(state, exception));
    }
}
```

> **The GraphQL error-match strings are PROVISIONAL** (plan ce-doc-review — adversarial). The benign-no-op ("already a draft" / "already ready" / "not a draft"), plan-unsupported ("draft … not supported"), and permission ("Resource not accessible") matches are inferred, and the tests above feed those exact strings back (tautological). Before relying on them, capture GitHub's REAL response bodies once (a markReady on an already-ready PR; a convert-to-draft on an already-draft PR; a convert on a drafts-disabled repo) and pin the matches to the observed text. Task 14's B2 step exercises an already-in-state click to catch a mismatch.

- [ ] **Step 2: Run tests to verify they fail**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter GitHubPrLifecycleWriterTests`
Expected: FAIL — `GitHubPrLifecycleWriter` does not exist.

- [ ] **Step 3: Implement the writer**

```csharp
// PRism.GitHub/GitHubPrLifecycleWriter.cs
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

// #566 IPrLifecycleWriter — REST close/reopen + GraphQL draft toggles. Transport rides the
// shared statics via the thin wrappers below (verbatim twins of GitHubReviewSubmitter's), and
// failures are classified into PrLifecycleErrorCode on the response body (NOT the bare status),
// per the spec's error-handling section. internal sealed; constructed via DI + the test factory.
internal sealed partial class GitHubPrLifecycleWriter : IPrLifecycleWriter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubPrLifecycleWriter> _log;

    public GitHubPrLifecycleWriter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        string host,
        ILogger<GitHubPrLifecycleWriter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubPrLifecycleWriter>.Instance;
    }

    public Task<PrLifecycleResult> CloseAsync(PrReference reference, CancellationToken ct) =>
        PatchStateAsync(reference, "closed", ct);

    public Task<PrLifecycleResult> ReopenAsync(PrReference reference, CancellationToken ct) =>
        PatchStateAsync(reference, "open", ct);

    public Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference reference, CancellationToken ct) =>
        RunDraftMutationAsync(reference, "markPullRequestReadyForReview", ct);

    public Task<PrLifecycleResult> ConvertToDraftAsync(PrReference reference, CancellationToken ct) =>
        RunDraftMutationAsync(reference, "convertPullRequestToDraft", ct);

    // ---- REST close/reopen ----
    private async Task<PrLifecycleResult> PatchStateAsync(PrReference reference, string state, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}";
        using var content = new StringContent($"{{\"state\":\"{state}\"}}", Encoding.UTF8, "application/json");
        using var http = _httpFactory.CreateClient("github");
        var token = await _readToken().ConfigureAwait(false);
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Patch, url, token, ct, content).ConfigureAwait(false);
        if (resp.IsSuccessStatusCode) return PrLifecycleResult.Ok;

        var body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
        var code = ClassifyRestFailure(resp.StatusCode, body, isReopen: state == "open");
        Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", state, (int)resp.StatusCode, GitHubHttp.Truncate(body, 1024));
        return PrLifecycleResult.Fail(code);
    }

    private static PrLifecycleErrorCode ClassifyRestFailure(HttpStatusCode status, string body, bool isReopen)
    {
        if (status == HttpStatusCode.TooManyRequests) return PrLifecycleErrorCode.RateLimited;
        if (isReopen && status == HttpStatusCode.UnprocessableEntity) return PrLifecycleErrorCode.ReopenNotPossible;
        if (status == HttpStatusCode.Forbidden)
        {
            // CORRECTED (plan ce-doc-review — adversarial): GitHub returns 403 for BOTH the
            // secondary-rate-limit/abuse family AND PRIMARY rate-limit exhaustion ("API rate
            // limit exceeded for …", X-RateLimit-Remaining: 0). Match "rate limit" broadly so a
            // rate-limited user is NOT told to fix their PAT scopes. This subsumes the secondary
            // wording.
            if (body.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
                || body.Contains("abuse", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RateLimited;
            if (body.Contains("Protected branch", StringComparison.OrdinalIgnoreCase)
                || body.Contains("Validation Failed", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RepoRuleBlocked;
            // Default 403: scope/permission denial OR non-collaborator (same body) — the FE copy covers both.
            return PrLifecycleErrorCode.TokenCannotWrite;
        }
        return PrLifecycleErrorCode.Generic;
    }

    // Map a non-2xx HTTP failure (thrown by GitHubGraphQL.PostAsync) to a code via its status.
    private static PrLifecycleErrorCode ClassifyHttpStatus(HttpStatusCode? status) => status switch
    {
        HttpStatusCode.TooManyRequests => PrLifecycleErrorCode.RateLimited,
        HttpStatusCode.Unauthorized => PrLifecycleErrorCode.TokenCannotWrite,
        HttpStatusCode.Forbidden => PrLifecycleErrorCode.TokenCannotWrite,
        _ => PrLifecycleErrorCode.Generic,
    };

    // ---- GraphQL draft toggles ----
    private async Task<PrLifecycleResult> RunDraftMutationAsync(PrReference reference, string mutation, CancellationToken ct)
    {
        var prLabel = $"{reference.Owner}/{reference.Repo}#{reference.Number}";
        string nodeId;
        try
        {
            nodeId = await ResolveNodeIdAsync(reference, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            // CORRECTED (plan ce-doc-review — feasibility + adversarial): classify on status,
            // don't blanket-Generic (a 401/403/429 during resolve keeps its meaning).
            Log.LifecycleFailed(_log, prLabel, $"{mutation}:resolve", (int?)ex.StatusCode ?? 0, ex.Message);
            return PrLifecycleResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }

        var query = $$"""
            mutation($id: ID!) {
              {{mutation}}(input: { pullRequestId: $id }) {
                pullRequest { isDraft }
              }
            }
            """;
        try
        {
            // CORRECTED (plan ce-doc-review — feasibility + adversarial): GitHubGraphQL.PostAsync
            // THROWS HttpRequestException on any non-2xx (only GraphQL field-errors arrive as
            // 200 + errors[]). The mutation call MUST be wrapped or a real 401/403/429/5xx escapes
            // as an unhandled 500 instead of a typed code.
            var body = await PostGraphQLAsync(query, new { id = nodeId }, ct).ConfigureAwait(false);
            return ClassifyGraphQLResult(body, mutation, reference);
        }
        catch (HttpRequestException ex)
        {
            Log.LifecycleFailed(_log, prLabel, mutation, (int?)ex.StatusCode ?? 0, ex.Message);
            return PrLifecycleResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }
    }

    private async Task<string> ResolveNodeIdAsync(PrReference reference, CancellationToken ct)
    {
        const string query = """
            query($owner: String!, $repo: String!, $number: Int!) {
              repository(owner: $owner, name: $repo) {
                pullRequest(number: $number) { id }
              }
            }
            """;
        var json = await PostGraphQLAsync(query, new { owner = reference.Owner, repo = reference.Repo, number = reference.Number }, ct).ConfigureAwait(false);
        using var doc = JsonDocument.Parse(json);
        if (doc.RootElement.TryGetProperty("data", out var data)
            && data.TryGetProperty("repository", out var repo)
            && repo.ValueKind == JsonValueKind.Object
            && repo.TryGetProperty("pullRequest", out var pr)
            && pr.ValueKind == JsonValueKind.Object
            && pr.TryGetProperty("id", out var id)
            && id.GetString() is { Length: > 0 } nodeId)
        {
            return nodeId;
        }
        throw new HttpRequestException($"No GraphQL node id for {reference.Owner}/{reference.Repo}#{reference.Number}");
    }

    private PrLifecycleErrorCode? FirstGraphQLErrorCode(string body, string mutation)
    {
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0)
            return null; // no errors
        // Inspect the first error message. "already ready"/"already a draft" → benign no-op (caller maps to Ok).
        var msg = errors[0].TryGetProperty("message", out var m) ? (m.GetString() ?? "") : "";
        if (msg.Contains("already a draft", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("already ready", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("not a draft", StringComparison.OrdinalIgnoreCase))
            return PrLifecycleErrorCode.None; // sentinel for benign
        if (mutation == "convertPullRequestToDraft"
            && (msg.Contains("draft", StringComparison.OrdinalIgnoreCase) && msg.Contains("not supported", StringComparison.OrdinalIgnoreCase)))
            return PrLifecycleErrorCode.PlanUnsupportedDrafts;
        if (errors[0].TryGetProperty("type", out var t) && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
            return PrLifecycleErrorCode.RateLimited;
        if (msg.Contains("not have permission", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("Resource not accessible", StringComparison.OrdinalIgnoreCase))
            return PrLifecycleErrorCode.TokenCannotWrite;
        return PrLifecycleErrorCode.Generic;
    }

    private PrLifecycleResult ClassifyGraphQLResult(string body, string mutation, PrReference reference)
    {
        var code = FirstGraphQLErrorCode(body, mutation);
        if (code is null) return PrLifecycleResult.Ok;                 // no errors
        if (code == PrLifecycleErrorCode.None) return PrLifecycleResult.Ok; // benign already-in-state
        Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", mutation, 200, GitHubHttp.Truncate(body, 1024));
        return PrLifecycleResult.Fail(code.Value);
    }

    // ---- transport wrappers (verbatim twins of GitHubReviewSubmitter's) ----
    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 1, EventName = "PrLifecycleFailed",
            Message = "PR lifecycle action failed: pr={Pr} action={Action} status={Status} body={Body}")]
        internal static partial void LifecycleFailed(ILogger logger, string pr, string action, int status, string body);
    }
}
```

> The class is declared `partial` above (plan ce-doc-review round 2 — feasibility): the nested `[LoggerMessage]` `Log` class requires **every enclosing type** to be `partial` for the source generator, so the literal block must compile as-is. Matches the `GitHubReviewSubmitter` precedent (`internal sealed partial class`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter GitHubPrLifecycleWriterTests`
Expected: PASS (all 13). If `Moq` is unavailable in `PRism.GitHub.Tests`, replace the factory mock with a tiny hand-rolled `IHttpClientFactory` stub class.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubPrLifecycleWriter.cs tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs
git commit -m "feat(#566): GitHubPrLifecycleWriter with body-level error classification"
```

---

## Task 4: DI registration in `AddPrismGitHub`

**Files:**
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (after the `IReviewSubmitter` registration, ~line 92)

**Interfaces:**
- Consumes: `GitHubPrLifecycleWriter` (Task 3). Produces: a resolvable `IPrLifecycleWriter`.

- [ ] **Step 1: Add the registration**

Immediately after the existing `services.AddSingleton<IReviewSubmitter>(…)` block, add:

```csharp
// #566 — IPrLifecycleWriter (close/reopen/draft toggles). Same late-bound host + token closure
// as the submitter; lifecycle writes share no mutable state with read/submit.
services.AddSingleton<IPrLifecycleWriter>(sp =>
{
    var config = sp.GetRequiredService<IConfigStore>();
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    return new GitHubPrLifecycleWriter(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        config.Current.Github.Host,
        sp.GetRequiredService<ILogger<GitHubPrLifecycleWriter>>());
});
```

- [ ] **Step 2: Build to verify**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' build PRism.GitHub`
Expected: succeeds.

- [ ] **Step 3: Commit**

```bash
git add PRism.GitHub/ServiceCollectionExtensions.cs
git commit -m "feat(#566): register IPrLifecycleWriter in AddPrismGitHub"
```

---

## Task 5: `PrDetailLoader` evicts on `PrLifecycleChanged`

**Files:**
- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs` (field, constructor subscribe, handler, dispose)
- Test: `tests/PRism.Core.Tests/PrDetail/PrDetailLoaderPrLifecycleTests.cs` (create) — OR extend the existing loader test that asserts `OnSingleCommentPosted` eviction.

**Interfaces:**
- Consumes: `PrLifecycleChanged` (Task 1). Produces: snapshot eviction on the event.

- [ ] **Step 1: Write the failing test**

Mirror the existing single-comment eviction test. Pattern:

```csharp
// tests/PRism.Core.Tests/PrDetail/PrDetailLoaderPrLifecycleTests.cs
[Fact]
public async Task PrLifecycleChanged_evicts_the_snapshot_despite_unchanged_headSha()
{
    // Arrange: a loader with a cached snapshot for prRef (load once so it caches).
    var (loader, bus, prRef) = await PrDetailLoaderTestSetup.WithCachedSnapshotAsync();
    loader.TryGetCachedSnapshot(prRef).Should().NotBeNull();

    // Act
    bus.Publish(new PrLifecycleChanged(prRef));

    // Assert
    loader.TryGetCachedSnapshot(prRef).Should().BeNull("a lifecycle change evicts the head-SHA-keyed snapshot");
}
```

> If no `PrDetailLoaderTestSetup` helper exists, copy the arrange block from the existing `OnSingleCommentPosted` loader test (same file area) and swap the published event.

- [ ] **Step 2: Run to verify it fails**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Core.Tests --filter PrLifecycleChanged_evicts`
Expected: FAIL (no subscription yet).

- [ ] **Step 3: Wire the subscription**

In `PrDetailLoader.cs`:

(a) Add a field near `_singleCommentSubscription` (~line 47):

```csharp
// #566: evict the PR's snapshot immediately on a lifecycle change (close/reopen/draft toggle) —
// same head-SHA-stable gotcha as #353/#392/#450; the explicit evict covers the draft toggles
// (which OnActivePrUpdated's done-state flip does NOT carry) and makes all four reconcile now.
private readonly IDisposable _prLifecycleSubscription;
```

(b) In the constructor, after `_singleCommentSubscription = eventBus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted);`:

```csharp
_prLifecycleSubscription = eventBus.Subscribe<PrLifecycleChanged>(OnPrLifecycleChanged);
```

(c) Near `OnSingleCommentPosted` (~line 148):

```csharp
// #566: see the constructor wire-up. Unconditional — fires only on an actual lifecycle write.
private void OnPrLifecycleChanged(PrLifecycleChanged evt) => Invalidate(evt.PrRef);
```

(d) In `Dispose()`, after `_singleCommentSubscription.Dispose();`:

```csharp
_prLifecycleSubscription.Dispose();
```

- [ ] **Step 4: Run to verify it passes**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Core.Tests --filter PrLifecycleChanged_evicts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/PrDetail/PrDetailLoader.cs tests/PRism.Core.Tests/PrDetail/PrDetailLoaderPrLifecycleTests.cs
git commit -m "feat(#566): PrDetailLoader evicts snapshot on PrLifecycleChanged"
```

---

## Task 6: SSE fan-out for `PrLifecycleChanged`

**Files:**
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (wire record + projection arm)
- Modify: `PRism.Web/Sse/SseChannel.cs` (field, subscribe, handler, dispose)
- Test: `tests/PRism.Web.Tests/Sse/SseChannelPrLifecycleTests.cs` (create)

**Interfaces:**
- Consumes: `PrLifecycleChanged` (Task 1). Produces: SSE event name `"pr-lifecycle-changed"` with payload `{ prRef }` — consumed by `useLifecycleChangedSubscriber` (Task 9).

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/PRism.Web.Tests/Sse/SseChannelPrLifecycleTests.cs
using FluentAssertions;
using Microsoft.AspNetCore.Http;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Web.Sse;
using Xunit;

namespace PRism.Web.Tests.Sse;

public class SseChannelPrLifecycleTests
{
    // Projection contract test (no channel needed).
    [Fact]
    public void PrLifecycleChanged_projects_to_pr_lifecycle_changed_with_string_pr_ref()
    {
        var evt = new PrLifecycleChanged(new PrReference("acme", "api", 123));
        var (eventName, payload) = SseEventProjection.Project(evt);
        var json = System.Text.Json.JsonSerializer.Serialize(payload, JsonSerializerOptionsFactory.Api);
        eventName.Should().Be("pr-lifecycle-changed");
        json.Should().Contain("\"prRef\":\"acme/api/123\"");
    }

    [Fact]
    public async Task PrLifecycleChanged_fans_out_to_subscribed_pr()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        using var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new System.IO.MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);

        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new PrLifecycleChanged(prRef));

        await WaitFor(() => !logger.Messages.IsEmpty, TimeSpan.FromSeconds(5));
        var line = logger.Messages.Single();
        line.Should().Contain("PrLifecycleChanged");
        line.Should().Contain("success=True");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }

    [Fact]
    public async Task Dispose_releases_the_PrLifecycleChanged_subscription()
    {
        var bus = new ReviewEventBus();
        var subs = new InboxSubscriberCount();
        var registry = new ActivePrSubscriberRegistry();
        var logger = new CapturingLogger(5);
        var channel = new SseChannel(bus, subs, registry, logger);

        var ctx = new DefaultHttpContext { Response = { Body = new System.IO.MemoryStream() } };
        using var cts = new CancellationTokenSource();
        var subscriberTask = channel.RunSubscriberAsync(ctx.Response, cookieSessionId: "c1", cts.Token);
        await WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        channel.Dispose();
        bus.Publish(new PrLifecycleChanged(prRef));

        await Task.Delay(500);
        logger.Messages.Should().BeEmpty("Dispose must unsubscribe PrLifecycleChanged");

        await cts.CancelAsync();
        try { await subscriberTask; } catch (OperationCanceledException) { } catch (IOException) { }
    }
}
```

> `CapturingLogger` and `WaitFor` are both helpers that live **private** inside `SseChannelDraftSubmittedTests.cs` (plan ce-doc-review round 2 — feasibility: there is no shared `SseTestUtil` type, and `WaitFor` is a private static there). Add a private `static async Task WaitFor(Func<bool> condition, TimeSpan timeout)` to **this** test file (copy the body verbatim from `SseChannelDraftSubmittedTests.WaitFor`) and reuse `CapturingLogger` the same way the existing SSE suites do (it is constructed `new CapturingLogger(5)` in those tests). The call sites above are written unqualified to match.

- [ ] **Step 2: Run to verify they fail**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter SseChannelPrLifecycleTests`
Expected: FAIL — projection arm + subscription missing (projection test throws `ArgumentOutOfRangeException`).

- [ ] **Step 3a: Add the wire record + projection arm**

In `SseEventProjection.cs`, after the `SingleCommentPostedWire` record (~line 67):

```csharp
// #566 — pr-lifecycle-changed: a PR lifecycle write succeeded (close/reopen/draft toggle).
// prRef only — the FE reloads PR detail off the signal (mirrors DraftSubmittedWire).
internal sealed record PrLifecycleChangedWire(string PrRef);
```

In the `Project` switch, before the `_ => throw` default arm:

```csharp
PrLifecycleChanged e => ("pr-lifecycle-changed", new PrLifecycleChangedWire(e.PrRef.ToString())),
```

- [ ] **Step 3b: Wire SseChannel**

In `SseChannel.cs`:

(a) Field near `_busSingleCommentPosted` (~line 54):

```csharp
// #566 — pr-lifecycle-changed: fans out per-PR so the acting tab + peers reload PR detail.
private readonly IDisposable _busPrLifecycleChanged;
```

(b) Constructor, after `_busSingleCommentPosted = bus.Subscribe<SingleCommentPostedBusEvent>(OnSingleCommentPosted);`:

```csharp
_busPrLifecycleChanged = bus.Subscribe<PrLifecycleChanged>(OnPrLifecycleChanged);
```

(c) Handler near `OnSingleCommentPosted` (~line 310):

```csharp
private void OnPrLifecycleChanged(PrLifecycleChanged evt) => FanoutProjected(evt, evt.PrRef);
```

(d) `Dispose()`, after `_busSingleCommentPosted.Dispose();`:

```csharp
_busPrLifecycleChanged.Dispose();
```

- [ ] **Step 4: Run to verify they pass**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter SseChannelPrLifecycleTests`
Expected: PASS (all 3).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Sse/SseEventProjection.cs PRism.Web/Sse/SseChannel.cs tests/PRism.Web.Tests/Sse/SseChannelPrLifecycleTests.cs
git commit -m "feat(#566): SSE fan-out + projection for PrLifecycleChanged"
```

---

## Task 7: `PrLifecycleEndpoints` (four POSTs)

**Files:**
- Create: `PRism.Web/Endpoints/PrLifecycleEndpoints.cs`
- Modify: the endpoint-mapping site (e.g. `PRism.Web/Program.cs` or `EndpointRouteBuilderExtensions`) to call `app.MapPrLifecycleEndpoints();`
- Create: `tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs` (+ `TestPrLifecycleWriter`)
- Create: `tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs`

**Interfaces:**
- Consumes: `IPrLifecycleWriter` + `PrLifecycleResult`/`PrLifecycleErrorCode` (Tasks 2–3); `IReviewEventBus`; `RequireSubscribed`; `TabStamps.TabIdHeader` + `PrDetailEndpoints.TabIdAllowlistRegex()`; `PrLifecycleChanged` (Task 1).
- Produces: `POST /api/pr/{owner}/{repo}/{number:int:min(1)}/{close|reopen|ready-for-review|convert-to-draft}` returning 200 / `{code}` + status.

- [ ] **Step 0: Read the real submit-endpoint guard + DI seam FIRST (plan ce-doc-review — scope + security)**

Before writing any code, read `PRism.Web/Endpoints/PrSubmitEndpoints.cs:91-123`, `PRism.Web/Endpoints/Shared/RequireSubscribed.cs`, and `PRism.Web/Endpoints/Shared/TabStamps.cs`. The real seam (verified by the plan review) is:
- **Tab-id gate:** `http.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault()` + `PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(tabId)` → on miss, 422 `tab-id-missing`. **Do NOT reimplement the regex** — call `PrDetailEndpoints.TabIdAllowlistRegex()`.
- **Subscribe gate:** `RequireSubscribed.Check(activePrCache, prRef, msg)` returns an `IResult` rejection (**HTTP 403 + code `"unauthorized"`** — NOT 401) when the session isn't subscribed; inject **`IActivePrCache`** (not an invented `ISubscriberRegistry`). Confirm the exact return contract (nullable `IResult` vs always-`IResult`) and mirror submit's call site.
- **Mapping site:** `PRism.Web/Program.cs:~390` (where `MapPrSubmitEndpoints()` is called).

The code below uses these real types. Substitute precisely if the source differs.

- [ ] **Step 1: Write the failing endpoint tests + the test context**

First the fake + context:

```csharp
// tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs
internal sealed class TestPrLifecycleWriter : IPrLifecycleWriter
{
    public PrLifecycleResult NextResult { get; set; } = PrLifecycleResult.Ok;
    public List<string> Calls { get; } = new();
    public Task<PrLifecycleResult> CloseAsync(PrReference r, CancellationToken ct) { Calls.Add("close"); return Task.FromResult(NextResult); }
    public Task<PrLifecycleResult> ReopenAsync(PrReference r, CancellationToken ct) { Calls.Add("reopen"); return Task.FromResult(NextResult); }
    public Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference r, CancellationToken ct) { Calls.Add("ready"); return Task.FromResult(NextResult); }
    public Task<PrLifecycleResult> ConvertToDraftAsync(PrReference r, CancellationToken ct) { Calls.Add("draft"); return Task.FromResult(NextResult); }
}
```

> Build the context by **copying `SubmitEndpointsTestContext`** and swapping `RemoveAll<IReviewSubmitter>()/AddSingleton(Submitter)` for `RemoveAll<IPrLifecycleWriter>()/AddSingleton(Writer)` (keep the `IReviewEventBus` + session-seed helpers; the lifecycle endpoint publishes a bus event and the test asserts on `Bus.Published`). Reuse `SeedSessionAsync`, `ValidSession`, `CreateClient`.
>
> **CRITICAL — do NOT inherit `AllSubscribedActivePrCache`** (plan ce-doc-review round 2 — feasibility, verified `tests/PRism.Web.Tests/TestHelpers/SubmitEndpointFakes.cs`): `SubmitEndpointsTestContext` registers `AllSubscribedActivePrCache`, whose `IsSubscribed(prRef) => true` is hardwired. With that fake the subscribe gate **never rejects**, so the `Unsubscribed_session_returns_403_unauthorized` test below can never go green AND the security gate the round-1 review added is left untested. Instead register a **configurable** cache — the repo already has `ConfigurableActivePrCache` (`tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs`) and `FakeCache(bool isSubscribed, …)` (`PrDraftEndpointTests.cs`). Expose a per-test toggle `SetSubscribed(bool)` on `PrLifecycleEndpointsTestContext` (default subscribed; the unsubscribed test calls `SetSubscribed(false)`). `SeedSessionAsync` leaves it subscribed for the happy/error-mapping tests.

Then the tests:

```csharp
// tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs
public class PrLifecycleEndpointsTests
{
    private static HttpRequestMessage Post(string action) =>
        new(HttpMethod.Post, $"/api/pr/o/r/1/{action}") { Headers = { { "X-PRism-Tab-Id", "tab-123" } } };

    [Fact]
    public async Task Close_success_returns_200_and_publishes_PrLifecycleChanged()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Ok;
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("close");
        await TestPoll.UntilAsync(() => ctx.Bus.Published.OfType<PrLifecycleChanged>().Any(), TimeSpan.FromSeconds(5), "PrLifecycleChanged should publish");
    }

    [Fact]
    public async Task Close_token_cannot_write_returns_403_with_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.TokenCannotWrite);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));

        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("code").GetString().Should().Be("token-cannot-write");
        ctx.Bus.Published.OfType<PrLifecycleChanged>().Should().BeEmpty();
    }

    // Plan ce-doc-review (scope): the spec lists repo-rule-blocked as a DISTINCT 403 case
    // (different FE copy — does NOT advise changing the PAT). Exercise the MapError branch.
    [Fact]
    public async Task Close_repo_rule_blocked_returns_403_with_distinct_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.RepoRuleBlocked);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("close"));
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("repo-rule-blocked");
    }

    [Fact]
    public async Task Reopen_not_possible_returns_422_with_code()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        ctx.Writer.NextResult = PrLifecycleResult.Fail(PrLifecycleErrorCode.ReopenNotPossible);
        using var client = ctx.CreateClient();

        var resp = await client.SendAsync(Post("reopen"));
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("reopen-not-possible");
    }

    [Fact]
    public async Task Missing_tab_id_header_is_rejected()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
        // Plan ce-doc-review round 2 (feasibility): CreateClient() DEFAULTS X-PRism-Tab-Id to
        // "tab-test" (TestClientExtensions adds it as a default header), so a plain client does
        // NOT exercise the missing-tab-id path — it sends a valid id and gets a 200. Pass
        // tabId: null to actually omit the header (the SubmitEndpointsTestContext pattern).
        using var client = ctx.CreateClient(tabId: null);

        var resp = await client.PostAsync("/api/pr/o/r/1/close", content: null); // genuinely no X-PRism-Tab-Id
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity); // tab-id-missing (match submit's status)
        ctx.Writer.Calls.Should().BeEmpty();
    }

    // Plan ce-doc-review (security): assert the ACTUAL status + code (403 + "unauthorized"),
    // not just "not 200" — a weak assertion masks the 401-vs-403 mismatch the FE depends on.
    [Fact]
    public async Task Unsubscribed_session_returns_403_unauthorized()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        ctx.SetSubscribed(false); // configurable cache → RequireSubscribed.Check rejects (NOT the all-subscribed fake)
        using var client = ctx.CreateClient();
        var resp = await client.SendAsync(Post("close"));
        resp.StatusCode.Should().Be(HttpStatusCode.Forbidden);
        (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be("unauthorized");
        ctx.Writer.Calls.Should().BeEmpty();
    }
}
```

> The missing-tab-id status (422 `tab-id-missing`) and the unsubscribed reject (403 `unauthorized`) are the real submit-endpoint contracts confirmed in Step 0. If the source differs, mirror it and update these assertions. The success test asserts the `PrLifecycleChanged` publish; **snapshot eviction is directly covered by Task 5 and the SSE projection-arm by Task 6** (the dedicated subscriber tests), so the endpoint test asserts the publish that triggers them rather than re-asserting the full chain end-to-end.

- [ ] **Step 2: Run to verify they fail**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter PrLifecycleEndpointsTests`
Expected: FAIL — endpoints not mapped (404).

- [ ] **Step 3: Implement the endpoints**

```csharp
// PRism.Web/Endpoints/PrLifecycleEndpoints.cs
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;

namespace PRism.Web.Endpoints;

internal static class PrLifecycleEndpoints
{
    public static void MapPrLifecycleEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/close",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, ct, (w, r, c) => w.CloseAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/reopen",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, ct, (w, r, c) => w.ReopenAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/ready-for-review",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, ct, (w, r, c) => w.MarkReadyForReviewAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/convert-to-draft",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, ct, (w, r, c) => w.ConvertToDraftAsync(r, c), writer));
    }

    private static async Task<IResult> HandleAsync(
        string owner, string repo, int number, HttpContext http,
        IReviewEventBus bus, IActivePrCache activePrCache, CancellationToken ct,
        Func<IPrLifecycleWriter, PrReference, CancellationToken, Task<PrLifecycleResult>> action,
        IPrLifecycleWriter writer)
    {
        var prRef = new PrReference(owner, repo, number);

        // CSRF custom-header gate — mirror PrSubmitEndpoints.cs:120-123 EXACTLY (call the shared
        // regex, do NOT reimplement it).
        var tabId = http.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault();
        if (string.IsNullOrEmpty(tabId) || !PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(tabId))
            return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

        // Subscribe guard — mirror PrSubmitEndpoints.cs:109-110. Returns a 403 + code "unauthorized"
        // IResult when not subscribed; the FE disambiguates by body code (403 is shared with
        // token-cannot-write). Confirm the exact nullable-IResult contract against the source.
        var reject = RequireSubscribed.Check(activePrCache, prRef, "lifecycle action");
        if (reject is not null) return reject;

        var result = await action(writer, prRef, ct).ConfigureAwait(false);
        if (result.Success)
        {
            bus.Publish(new PrLifecycleChanged(prRef));
            return Results.Ok();
        }

        var (code, status) = MapError(result.ErrorCode);
        // The writer already logged the GitHub body server-side; nothing sensitive in the client DTO.
        return Results.Json(new { code }, statusCode: status);
    }

    private static (string Code, int Status) MapError(PrLifecycleErrorCode code) => code switch
    {
        PrLifecycleErrorCode.TokenCannotWrite      => ("token-cannot-write", StatusCodes.Status403Forbidden),
        PrLifecycleErrorCode.RepoRuleBlocked       => ("repo-rule-blocked", StatusCodes.Status403Forbidden),
        PrLifecycleErrorCode.ReopenNotPossible     => ("reopen-not-possible", StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.PlanUnsupportedDrafts => ("plan-unsupported-drafts", StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.RateLimited           => ("rate-limited", StatusCodes.Status429TooManyRequests),
        _                                          => ("generic", StatusCodes.Status502BadGateway),
    };
}
```

> The guard + DI types above are the real ones confirmed in Step 0 (`TabStamps.TabIdHeader`, `PrDetailEndpoints.TabIdAllowlistRegex()`, `RequireSubscribed.Check(activePrCache, …)`, `IActivePrCache`). If the source signatures differ, substitute precisely — do not reimplement the regex or the subscribe check.

> **Route constraint `{number:int:min(1)}`** (plan ce-doc-review round 2 — adversarial): the bare `int` constraint accepts `0` and negatives (`/api/pr/o/r/-1/close` would route and build `PrReference("o","r",-1)`). The subscribe gate already rejects an unsubscribed bogus PR, so this is defense-in-depth, not a live hole — but `:min(1)` fails fast with a 404 before the writer and self-documents the domain. No new test is required (the subscribe gate test already covers rejection); the constraint is the belt to that suspenders.

- [ ] **Step 3b: Map the endpoints**

At the endpoint-mapping site (where `MapPrSubmitEndpoints()` etc. are called), add:

```csharp
app.MapPrLifecycleEndpoints();
```

- [ ] **Step 4: Run to verify they pass**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter PrLifecycleEndpointsTests`
Expected: PASS (all 6).

- [ ] **Step 5: Full backend gate + commit**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' build` then `& 'C:\Program Files\dotnet\dotnet.exe' test`
Expected: green.

```bash
git add PRism.Web/Endpoints/PrLifecycleEndpoints.cs tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs PRism.Web/Program.cs
git commit -m "feat(#566): PrLifecycleEndpoints (close/reopen/ready/convert-to-draft) with CSRF + subscribe guards"
```

---

## Task 8: `prLifecycle` API client

**Files:**
- Create: `frontend/src/api/prLifecycle.ts`
- Test: `frontend/src/api/prLifecycle.test.ts` (create)

**Interfaces:**
- Consumes: `apiClient.post` (`frontend/src/api/client.ts` — already attaches `X-PRism-Tab-Id` on every request).
- Produces:
  - `type PrLifecycleErrorCode = 'token-cannot-write' | 'repo-rule-blocked' | 'reopen-not-possible' | 'plan-unsupported-drafts' | 'rate-limited' | 'subscribe-rejected' | 'generic'`
  - `interface PrActionResult { ok: boolean; code?: PrLifecycleErrorCode }`
  - `closePr / reopenPr / markReady / convertToDraft: (prRef: PrReference) => Promise<PrActionResult>`

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/api/prLifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
// CORRECTED mock: the real ApiError is { status, requestId, body } (client.ts:4-14) — the
// kebab code lives inside `body`, not a `.code` field. The mock MUST mirror that shape or the
// test false-passes against a contract the backend never emits.
vi.mock('./client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    requestId: string | null;
    body: unknown;
    constructor(status: number, body?: unknown) {
      super(String(status));
      this.status = status;
      this.requestId = null;
      this.body = body;
    }
  },
}));

import { closePr, reopenPr, markReady, convertToDraft } from './prLifecycle';
import { ApiError } from './client';

const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('prLifecycle client', () => {
  beforeEach(() => post.mockReset());

  it('closePr POSTs the close path and returns ok on success', async () => {
    post.mockResolvedValueOnce(undefined);
    const r = await closePr(prRef);
    expect(post).toHaveBeenCalledWith('/api/pr/o/r/1/close');
    expect(r).toEqual({ ok: true });
  });

  it('maps a 403 token-cannot-write (code in body) to a typed code', async () => {
    post.mockRejectedValueOnce(new ApiError(403, { code: 'token-cannot-write' }));
    const r = await closePr(prRef);
    expect(r).toEqual({ ok: false, code: 'token-cannot-write' });
  });

  it('maps a 422 reopen-not-possible from reopen', async () => {
    post.mockRejectedValueOnce(new ApiError(422, { code: 'reopen-not-possible' }));
    const r = await reopenPr(prRef);
    expect(r).toEqual({ ok: false, code: 'reopen-not-possible' });
  });

  it('falls back to generic for an unknown code', async () => {
    post.mockRejectedValueOnce(new ApiError(502, { code: 'something-weird' }));
    const r = await markReady(prRef);
    expect(r).toEqual({ ok: false, code: 'generic' });
  });

  it('maps a 403 "unauthorized" (RequireSubscribed reject) to subscribe-rejected', async () => {
    post.mockRejectedValueOnce(new ApiError(403, { code: 'unauthorized' }));
    const r = await convertToDraft(prRef);
    expect(r).toEqual({ ok: false, code: 'subscribe-rejected' });
  });
});
```

> Confirm the real `ApiError` field names against `client.ts` (it is `{ status, requestId, body }`; on a non-OK response the JSON body is parsed into `.body`). If `client.ts` exposes the parsed body under a different name, adjust `e.body` in the implementation + the mock to match. The endpoint's subscribe-reject code is whatever `RequireSubscribed.Check` emits — the reviews observed `"unauthorized"`; confirm that exact string and map it.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx vitest run src/api/prLifecycle.test.ts` — **use the local binary, not `npx`**: `cd frontend && node_modules/.bin/vitest run src/api/prLifecycle.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the client**

```typescript
// frontend/src/api/prLifecycle.ts
import { apiClient, ApiError } from './client';
import type { PrReference } from './types';

export type PrLifecycleErrorCode =
  | 'token-cannot-write'
  | 'repo-rule-blocked'
  | 'reopen-not-possible'
  | 'plan-unsupported-drafts'
  | 'rate-limited'
  | 'subscribe-rejected'
  | 'generic';

export interface PrActionResult {
  ok: boolean;
  code?: PrLifecycleErrorCode;
}

const KNOWN: ReadonlySet<string> = new Set([
  'token-cannot-write',
  'repo-rule-blocked',
  'reopen-not-possible',
  'plan-unsupported-drafts',
  'rate-limited',
]);

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

async function run(prRef: PrReference, action: string): Promise<PrActionResult> {
  try {
    // apiClient.post attaches X-PRism-Tab-Id on every request (api/client.ts).
    await apiClient.post(`${prPath(prRef)}/${action}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      // CORRECTED (plan ce-doc-review — feasibility + security + adversarial, verified
      // client.ts): ApiError is { status, requestId, body } — there is NO `.code` field.
      // The endpoint returns the kebab code inside the JSON body ({ code }), so read e.body.code.
      const raw = (e.body as { code?: string } | null | undefined)?.code;
      // RequireSubscribed rejects with HTTP 403 + code "unauthorized" (NOT 401 — and client.ts
      // pre-empts any real 401 with a global prism-auth-rejected dispatch before throwing). 403
      // is shared with token-cannot-write, so disambiguate by CODE, not status.
      if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
      const code = raw && KNOWN.has(raw) ? (raw as PrLifecycleErrorCode) : 'generic';
      return { ok: false, code };
    }
    return { ok: false, code: 'generic' };
  }
}

export const closePr = (prRef: PrReference) => run(prRef, 'close');
export const reopenPr = (prRef: PrReference) => run(prRef, 'reopen');
export const markReady = (prRef: PrReference) => run(prRef, 'ready-for-review');
export const convertToDraft = (prRef: PrReference) => run(prRef, 'convert-to-draft');
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/api/prLifecycle.test.ts`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/api/prLifecycle.ts src/api/prLifecycle.test.ts
git add frontend/src/api/prLifecycle.ts frontend/src/api/prLifecycle.test.ts
git commit -m "feat(#566): prLifecycle api client + typed error codes"
```

---

## Task 9: `useLifecycleChangedSubscriber` (+ register the SSE event type)

**Files:**
- Modify: `frontend/src/api/types.ts` — add the `PrLifecycleChangedEvent` payload type.
- Modify: `frontend/src/api/events.ts` — add `'pr-lifecycle-changed'` to **both** `EventPayloadByType` AND the `EVENT_TYPES` const array.
- Create: `frontend/src/hooks/useLifecycleChangedSubscriber.ts`
- Test: `frontend/src/hooks/useLifecycleChangedSubscriber.test.ts`

**Interfaces:**
- Consumes: `useEventSource`, `prRefKey` (mirror `useSingleCommentPostedSubscriber`). SSE event name `'pr-lifecycle-changed'` (Task 6).
- Produces: `useLifecycleChangedSubscriber({ prRef, onChanged }): void`.

> **CRITICAL (plan ce-doc-review — feasibility, verified `events.ts`).** `stream.on` is strictly typed: `on<T extends keyof EventPayloadByType>(type: T, …)`. Adding the type entry is **necessary but not sufficient** — `EventSource.addEventListener` is only called for names in the **`EVENT_TYPES` const array** (`events.ts`, ~lines 80-95 + 353-354; the file's own comment states this). If `'pr-lifecycle-changed'` is missing from `EVENT_TYPES`, the listener is never registered at runtime and the acting tab never reloads — **while the Task-9 vitest (which mocks `useEventSource` with a permissive fake `on`) still passes green.** Both edits below are load-bearing; do Step 0 first.

- [ ] **Step 0: Register the event type + runtime name (do this FIRST)**

In `frontend/src/api/types.ts`, add (next to the other SSE event payload types):

```typescript
export interface PrLifecycleChangedEvent {
  prRef: string;
}
```

In `frontend/src/api/events.ts`, add `'pr-lifecycle-changed': PrLifecycleChangedEvent` to the `EventPayloadByType` map (import the type), **and** add `'pr-lifecycle-changed'` to the `EVENT_TYPES` const array (the runtime registration list — find `'single-comment-posted'` in BOTH places and mirror it). Build to confirm: `cd frontend && node_modules/.bin/tsc -b`.

- [ ] **Step 1: Write the failing test**

```typescript
// frontend/src/hooks/useLifecycleChangedSubscriber.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const listeners: Record<string, ((p: unknown) => void)[]> = {};
const stableStream = {
  on: (type: string, cb: (p: unknown) => void) => {
    (listeners[type] ??= []).push(cb);
    return () => { listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb); };
  },
};
vi.mock('./useEventSource', () => ({ useEventSource: () => stableStream }));

import { useLifecycleChangedSubscriber } from './useLifecycleChangedSubscriber';

function fire(type: string, payload: unknown) { (listeners[type] ?? []).forEach((cb) => cb(payload)); }

describe('useLifecycleChangedSubscriber', () => {
  beforeEach(() => { for (const k of Object.keys(listeners)) delete listeners[k]; });

  it('calls onChanged for a matching prRef', async () => {
    const onChanged = vi.fn();
    renderHook(() => useLifecycleChangedSubscriber({ prRef: { owner: 'o', repo: 'r', number: 1 }, onChanged }));
    await waitFor(() => expect(listeners['pr-lifecycle-changed']?.length).toBeGreaterThan(0));
    act(() => fire('pr-lifecycle-changed', { prRef: 'o/r/1' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores a different prRef', async () => {
    const onChanged = vi.fn();
    renderHook(() => useLifecycleChangedSubscriber({ prRef: { owner: 'o', repo: 'r', number: 1 }, onChanged }));
    await waitFor(() => expect(listeners['pr-lifecycle-changed']?.length).toBeGreaterThan(0));
    act(() => fire('pr-lifecycle-changed', { prRef: 'o/r/2' }));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/useLifecycleChangedSubscriber.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement (mirror `useSingleCommentPostedSubscriber`)**

```typescript
// frontend/src/hooks/useLifecycleChangedSubscriber.ts
import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseLifecycleChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a PR lifecycle change for this PR. Caller (PrDetailView)
  // clears the transition latch then reloads PR detail so the panel swaps button sets.
  onChanged: () => void;
}

// Subscribes to 'pr-lifecycle-changed' SSE events, filtering by prRef. Mirrors
// useSingleCommentPostedSubscriber. #566 reusable foundation (#571 reuses the shape).
export function useLifecycleChangedSubscriber({
  prRef,
  onChanged,
}: UseLifecycleChangedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('pr-lifecycle-changed', (event) => {
      if (event.prRef !== prRefStr) return;
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onChanged]);
}
```

> The `EventPayloadByType` + `EVENT_TYPES` registration was done in Step 0 — `event.prRef` typechecks and the listener registers at runtime.

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/useLifecycleChangedSubscriber.test.ts`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/hooks/useLifecycleChangedSubscriber.ts src/hooks/useLifecycleChangedSubscriber.test.ts
git add frontend/src/hooks/useLifecycleChangedSubscriber.ts frontend/src/hooks/useLifecycleChangedSubscriber.test.ts
git commit -m "feat(#566): useLifecycleChangedSubscriber SSE hook"
```

---

## Task 10: `usePrAction` hook

**Files:**
- Create: `frontend/src/hooks/usePrAction.ts`
- Test: `frontend/src/hooks/usePrAction.test.ts`

**Interfaces:**
- Consumes: `closePr/reopenPr/markReady/convertToDraft` + `PrActionResult`/`PrLifecycleErrorCode` (Task 8); `useToast` (`show({kind:'error', message})`).
- Produces:
  - `type PrActionKind = 'close' | 'reopen' | 'ready' | 'convert-to-draft'`
  - `interface PrLifecycleState { isClosed: boolean; isDraft: boolean }`
  - `interface UsePrActionArgs { prRef: PrReference; reload: () => void; prState: PrLifecycleState | undefined }` (`prState` = the PR's currently-observed lifecycle state; the fallback is cancelled when it reaches the action's target — see the reconcile-signal note).
  - `interface UsePrActionResult { pending: PrActionKind | null; invoke: (kind: PrActionKind) => void }`

- [ ] **Step 1: Write the failing tests**

```typescript
// frontend/src/hooks/usePrAction.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const closePr = vi.fn();
const reopenPr = vi.fn();
const markReady = vi.fn();
vi.mock('../api/prLifecycle', () => ({
  // The arrow wrappers defer the var reference to CALL time, so vi.mock hoisting is fine.
  closePr: (...a: unknown[]) => closePr(...a),
  reopenPr: (...a: unknown[]) => reopenPr(...a),
  markReady: (...a: unknown[]) => markReady(...a),
  convertToDraft: vi.fn(),
}));
const show = vi.fn();
vi.mock('../components/Toast/useToast', () => ({ useToast: () => ({ show, dismiss: vi.fn(), toasts: [] }) }));

import { usePrAction } from './usePrAction';

const prRef = { owner: 'o', repo: 'r', number: 1 };
const OPEN = { isClosed: false, isDraft: false };      // close target NOT yet reached
const CLOSED = { isClosed: true, isDraft: false };     // close target reached

describe('usePrAction', () => {
  beforeEach(() => { closePr.mockReset(); reopenPr.mockReset(); markReady.mockReset(); show.mockReset(); vi.useRealTimers(); });

  it('sets pending then clears it on POST 200', async () => {
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: OPEN }));

    act(() => result.current.invoke('close'));
    expect(result.current.pending).toBe('close');

    await act(async () => { resolve({ ok: true }); });
    await waitFor(() => expect(result.current.pending).toBeNull());
  });

  it('re-entrancy guard ignores a second invoke while one is in flight (same kind)', async () => {
    closePr.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    act(() => result.current.invoke('close'));
    act(() => result.current.invoke('close'));
    expect(closePr).toHaveBeenCalledTimes(1);
  });

  it('re-entrancy guard blocks a DIFFERENT kind while one is in flight (adversarial: single inFlight ref)', async () => {
    closePr.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    act(() => result.current.invoke('close'));
    act(() => result.current.invoke('reopen'));
    expect(closePr).toHaveBeenCalledTimes(1);
    expect(reopenPr).not.toHaveBeenCalled(); // the single inFlight ref blocks a different kind too
  });

  it('on failure clears pending and shows an error toast with mapped copy', async () => {
    closePr.mockResolvedValueOnce({ ok: false, code: 'token-cannot-write' });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => { result.current.invoke('close'); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(show.mock.calls[0][0].message).toMatch(/Pull requests: Read and write/);
  });

  // Plan ce-doc-review round 2 (scope): the spec lists ALL SIX codes as required copy mappings.
  it.each([
    ['repo-rule-blocked', /repository rule/i],
    ['reopen-not-possible', /source branch was deleted/i],
    ['plan-unsupported-drafts', /draft pull requests/i],
    ['subscribe-rejected', /lost access/i],
    ['something-unknown', /could not be completed/i], // generic fallthrough
  ])('maps the %s error code to its copy', async (code, re) => {
    closePr.mockResolvedValueOnce({ ok: false, code });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => { result.current.invoke('close'); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show.mock.calls[0][0].message).toMatch(re);
  });

  it('does NOT show an error toast on a benign success', async () => {
    markReady.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => { result.current.invoke('ready'); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).not.toHaveBeenCalled();
  });

  it('fires the fallback reload if the target state is NOT observed within the timeout', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    // prState stays OPEN — the close target (isClosed) is never observed.
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: OPEN }));
    await act(async () => { result.current.invoke('close'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the fallback when an unrelated reload changes prState but NOT to the target', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    await act(async () => { result.current.invoke('close'); });
    // A comment-post reload swaps prState to a NEW open object (still not closed): fallback must STAY armed.
    prState = { isClosed: false, isDraft: false };
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).toHaveBeenCalledTimes(1); // unrelated reload did NOT disarm it (round-2 finding A1)
  });

  it('cancels the fallback when the target state is observed after the timer armed', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    await act(async () => { result.current.invoke('close'); });
    // The action's own reconcile reload flips the PR to closed:
    prState = CLOSED;
    rerender();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does NOT arm the fallback when the target state is reached BEFORE the POST resolves (arm-after-reload race)', async () => {
    vi.useFakeTimers();
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    act(() => result.current.invoke('close'));
    // Fast SSE reload flips to closed BEFORE the POST 200 resolves:
    prState = CLOSED;
    rerender();
    await act(async () => { resolve({ ok: true }); }); // .then sees target already reached — must NOT arm
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/usePrAction.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the hook**

```typescript
// frontend/src/hooks/usePrAction.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { closePr, reopenPr, markReady, convertToDraft, type PrLifecycleErrorCode } from '../api/prLifecycle';
import type { PrReference } from '../api/types';
import { useToast } from '../components/Toast/useToast';

export type PrActionKind = 'close' | 'reopen' | 'ready' | 'convert-to-draft';

export interface PrLifecycleState {
  isClosed: boolean;
  isDraft: boolean;
}

export interface UsePrActionArgs {
  prRef: PrReference;
  reload: () => void;
  // The PR's currently-observed lifecycle state. The reconcile fallback is cancelled when this
  // reaches the action's target (close→isClosed, reopen→!isClosed, ready→open+non-draft,
  // convert-to-draft→open+draft) — NOT on a bare object-identity change, which any of the six
  // unrelated reload triggers in PrDetailView would spuriously satisfy. See the plan's
  // reconcile-signal note (round-2 adversarial finding A1).
  prState: PrLifecycleState | undefined;
}

export interface UsePrActionResult {
  pending: PrActionKind | null;
  invoke: (kind: PrActionKind) => void;
}

const FALLBACK_MS = 5000;

const ACTIONS: Record<PrActionKind, (prRef: PrReference) => Promise<{ ok: boolean; code?: PrLifecycleErrorCode }>> = {
  close: closePr,
  reopen: reopenPr,
  ready: markReady,
  'convert-to-draft': convertToDraft,
};

// Has the observed PR state reached the target for this action? Used to cancel the SSE-drop
// fallback ONLY on the action's own reconcile (not on any unrelated reload). (Round-2 finding A1.)
function reachedTarget(kind: PrActionKind, s: PrLifecycleState): boolean {
  switch (kind) {
    case 'close':
      return s.isClosed;
    case 'reopen':
      return !s.isClosed;
    case 'ready':
      return !s.isClosed && !s.isDraft;
    case 'convert-to-draft':
      return !s.isClosed && s.isDraft;
  }
}

function copyFor(code: PrLifecycleErrorCode | undefined): string {
  switch (code) {
    case 'token-cannot-write':
      return "PRism can't change this PR's state. Grant PR-write access: classic PAT → the `repo` scope; fine-grained PAT → 'Pull requests: Read and write'. If you're not a collaborator on this repository, lifecycle actions require collaborator access.";
    case 'repo-rule-blocked':
      return 'A repository rule (e.g. branch protection) blocked this action.';
    case 'reopen-not-possible':
      return "This PR can't be reopened — its source branch was deleted.";
    case 'plan-unsupported-drafts':
      return "This repository's plan doesn't support draft pull requests.";
    case 'rate-limited':
      return 'GitHub is rate-limiting requests. Try again shortly.';
    case 'subscribe-rejected':
      return 'This session lost access to the PR. Reload the page.';
    default:
      return 'The action could not be completed. Try again.';
  }
}

export function usePrAction({ prRef, reload, prState }: UsePrActionArgs): UsePrActionResult {
  const [pending, setPending] = useState<PrActionKind | null>(null);
  const inFlight = useRef(false);                 // synchronous re-entrancy guard (across ALL kinds)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKindRef = useRef<PrActionKind | null>(null); // the action whose target we await
  // latestState mirrors prState on EVERY render so the POST's .then closure compares against the
  // CURRENT observed state, not the value when invoke ran. This closes the arm-after-reload race:
  // the bus publishes synchronously before the POST's 200 resolves, so a fast SSE reload can flip
  // the state BEFORE .then runs — .then must then NOT arm a doomed timer.
  const latestState = useRef<PrLifecycleState | undefined>(prState);
  latestState.current = prState;
  const { show } = useToast();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cancel the fallback once the observed PR state reaches the pending action's target. An
  // unrelated reload that changes prState WITHOUT reaching the target leaves the timer armed —
  // which is the whole point: the fallback must survive a concurrent comment/draft/re-activation
  // reload and only stand down when THIS action's reconcile actually lands (round-2 finding A1).
  useEffect(() => {
    const kind = pendingKindRef.current;
    if (kind && prState && reachedTarget(kind, prState)) {
      pendingKindRef.current = null;
      clearTimer();
    }
  }, [prState?.isClosed, prState?.isDraft, clearTimer]);

  // Tidy the timer on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  const invoke = useCallback(
    (kind: PrActionKind) => {
      if (inFlight.current) return;               // ignore double-clicks / a second kind mid-flight
      inFlight.current = true;
      setPending(kind);
      void ACTIONS[kind](prRef)
        .then((r) => {
          setPending(null);
          inFlight.current = false;
          if (!r.ok) {
            show({ kind: 'error', message: copyFor(r.code) });
            return;
          }
          // Success: if the reconcile reload already brought the PR to the target state (a fast SSE
          // landed before the POST resolved), no fallback is needed.
          if (latestState.current && reachedTarget(kind, latestState.current)) return;
          // Otherwise arm the SSE-drop fallback; the prState effect cancels it once the target is observed.
          pendingKindRef.current = kind;
          clearTimer();
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            pendingKindRef.current = null;
            reload();
          }, FALLBACK_MS);
        })
        .catch(() => {
          setPending(null);
          inFlight.current = false;
          show({ kind: 'error', message: copyFor('generic') });
        });
    },
    [prRef, reload, show, clearTimer],
  );

  return { pending, invoke };
}
```

> The confirm-clear-on-external-state-change (decision 2 / round-2 finding E) lives in `PrActionsPanel` (Task 12), not here — the panel owns `isConfirming`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/usePrAction.test.ts`
Expected: PASS (all 14, counting the 5 parameterized copy cases).

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/hooks/usePrAction.ts src/hooks/usePrAction.test.ts
git add frontend/src/hooks/usePrAction.ts frontend/src/hooks/usePrAction.test.ts
git commit -m "feat(#566): usePrAction (pending-reconcile, re-entrancy guard, fallback, error copy)"
```

---

## Task 11: Split the Overview DOM (scroller / content column)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css`
- Test: existing `frontend/__tests__/OverviewTab.test.tsx` must stay green (the `data-testid="overview-tab"` locator must still resolve).

**Interfaces:** no new exports. Restructures the single combined `<div>` into an outer scroller + inner content column so Task 12 can mount the panel as a footer sibling.

- [ ] **Step 1: Confirm the current structure + the testid expectation**

Run: `cd frontend && node_modules/.bin/vitest run __tests__/OverviewTab.test.tsx`
Expected: PASS (baseline green before the change). Note which element the test queries by `data-testid="overview-tab"`.

- [ ] **Step 2: Restructure the JSX**

Change the single combined element:

```tsx
return (
  <div className={`${styles.overviewTab} ${styles.overviewGrid}`} data-testid="overview-tab">
    {/* AiSummaryCard … ReviewFilesCta */}
  </div>
);
```

to an outer scroller wrapping an inner content column. Keep `data-testid="overview-tab"` on the **outer** scroller (so the existing locator resolves to the scroll container, the element that owns `overflow:auto`):

```tsx
return (
  <div className={styles.overviewTab} data-testid="overview-tab">
    <div className={styles.overviewGrid}>
      {/* AiSummaryCard … ReviewFilesCta — unchanged children */}
    </div>
    {/* Task 12 mounts <PrActionsPanel /> here, as a sibling of the grid */}
  </div>
);
```

- [ ] **Step 3: Split the CSS**

In `OverviewTab.module.css`, keep `.overviewTab` as the scroller and `.overviewGrid` as the centered content column (they already carry the right rules — this split just stops applying both to one node). Verify `.overviewTab` keeps `flex:1; overflow:auto` and `.overviewGrid` keeps `width: min(80%, …); margin:0 auto; padding; display:flex; flex-direction:column; gap`.

**One required rule change (plan ce-doc-review round 2 — design D1):** the Task-12 panel is `position: sticky; bottom: 0` *inside* this scroller, so mid-scroll it overlays the last ~1 button-row of grid content (`ReviewFilesCta` / the last card are most at risk). Add bottom clearance so the last content can always clear the pinned panel:

```css
.overviewGrid {
  /* …existing rules… */
  padding-bottom: var(--s-9, 56px); /* ≈ panel height (button + padding + border); owner tunes at the B1 gate */
}
```

Use the project's real spacing token (check the existing `--s-*` scale); the point is reserved clearance, not an exact pixel. (The earlier "no rule changes needed" was wrong for the sticky-overlay case.)

- [ ] **Step 4: Run the Overview test + the broader PrDetail suite**

Run: `cd frontend && node_modules/.bin/vitest run __tests__/OverviewTab.test.tsx`
Expected: PASS (testid still resolves; content unchanged). If the test queried a child via the testid'd node and now finds the wrapper, adjust the test query to scope into the grid — but prefer keeping the testid on the scroller and updating the test only if it breaks.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/OverviewTab/OverviewTab.tsx
git add frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx frontend/src/components/PrDetail/OverviewTab/OverviewTab.module.css frontend/__tests__/OverviewTab.test.tsx
git commit -m "refactor(#566): split Overview DOM into scroller + content column for the actions footer"
```

---

## Task 12: `PrActionsPanel` component

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.module.css`
- Test: `frontend/__tests__/PrActionsPanel.test.tsx`

**Interfaces:**
- Consumes: `usePrDetailContext()` data — `prDetail.pr` (`isDraft/isClosed/isMerged/state`), `readOnly`, `prRef`, `reload`, and `prDetail.pr`'s `{ isClosed, isDraft }` (as `usePrAction`'s `prState`). Uses `usePrAction` (Task 10). `reload` is added to the context in Step 0 below (ordering fix — plan ce-doc-review: this task reads `reload`, so it must exist before this task's tests compile).
- Produces: `export function PrActionsPanel(): JSX.Element | null`.

**Render rules (spec):** returns `null` when cold-load (no `prDetail`), `readOnly`, or merged. Otherwise renders the state-aware button set with the inline Close confirm.

- [ ] **Step 0: Add `reload` to the context type + test default (must precede this task — ordering fix)**

This task's component reads `reload` from context and its tests call `makePrDetailContextValue`, so both must know `reload` first. (Previously these edits lived in Task 13 step 1-2 which ran *after* this task — a compile-order bug caught by the plan review.)

In `frontend/src/components/PrDetail/prDetailContext.tsx`, add to `PrDetailContextValue`:

```typescript
  // #566 — lets the Overview PrActionsPanel trigger a PR-detail reload (SSE-drop fallback).
  reload: () => void;
```

In `frontend/src/components/PrDetail/testUtils.tsx`, add to the object `makePrDetailContextValue` returns:

```typescript
    reload: vi.fn(),
```

Build to confirm: `cd frontend && node_modules/.bin/tsc -b` (existing `renderWithPrDetailContext` tests still typecheck; the real provider value gets `reload` wired in Task 13).

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/__tests__/PrActionsPanel.test.tsx
import { useState } from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrActionsPanel } from '../src/components/PrDetail/OverviewTab/PrActionsPanel';
import { renderWithPrDetailContext } from '../src/components/PrDetail/testUtils';
import { makePrDetailContextValue } from '../src/components/PrDetail/testUtils';
import { PrDetailContextProvider, type PrDetailContextValue } from '../src/components/PrDetail/prDetailContext';
import { makePr, makePrDetailDto } from './helpers/prDetail';

const invoke = vi.fn();
let pending: string | null = null;
vi.mock('../src/hooks/usePrAction', () => ({
  usePrAction: () => ({ pending, invoke }),
}));

// Local harness (plan ce-doc-review round 2 — coherence C1/C2): renderWithPrDetailContext returns a
// plain RTL result whose `.rerender` CANNOT swap the provider value, so the click-outside,
// external-state, and focus-on-swap tests use this harness — it holds the context overrides in
// state (a test calls `ctl.current!.set({...})` to swap them at runtime) and mounts an outside
// button beside the panel. Confirm the provider export name against prDetailContext.tsx
// (`PrDetailContextProvider` per the file's own provider) and makePrDetailContextValue's arg shape.
type Ctl = { set: (o: Partial<PrDetailContextValue>) => void };
function Harness({ initial, ctl }: { initial: Partial<PrDetailContextValue>; ctl: { current: Ctl | null } }) {
  const [overrides, setOverrides] = useState<Partial<PrDetailContextValue>>(initial);
  ctl.current = { set: (o) => setOverrides((p) => ({ ...p, ...o })) };
  return (
    <PrDetailContextProvider value={makePrDetailContextValue(overrides)}>
      <button>outside</button>
      <PrActionsPanel />
    </PrDetailContextProvider>
  );
}

describe('PrActionsPanel', () => {
  beforeEach(() => { invoke.mockReset(); pending = null; });

  function renderPanel(prOverrides: Partial<ReturnType<typeof makePr>>, ctxOverrides = {}) {
    const prDetail = makePrDetailDto({ pr: makePr({ state: 'open', isDraft: false, isClosed: false, isMerged: false, ...prOverrides }) });
    return renderWithPrDetailContext(<PrActionsPanel />, { prDetail, ...ctxOverrides });
  }

  it('renders Convert-to-draft + Close for an open non-draft PR', () => {
    renderPanel({});
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('renders Mark-ready + Close for an open draft PR', () => {
    renderPanel({ isDraft: true });
    expect(screen.getByRole('button', { name: /ready for review/i })).toBeInTheDocument();
  });

  it('renders only Reopen for a closed PR', () => {
    renderPanel({ state: 'closed', isClosed: true });
    expect(screen.getByRole('button', { name: /reopen/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^close$/i })).not.toBeInTheDocument();
  });

  it('renders nothing for a merged PR', () => {
    const { container } = renderPanel({ state: 'merged', isMerged: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when readOnly', () => {
    const { container } = renderPanel({}, { readOnly: true });
    expect(container).toBeEmptyDOMElement();
  });

  it('Close uses a two-step inline confirm: first click morphs, Confirm invokes', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    // morph: prompt + Cancel + Confirm close; siblings disabled
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /convert to draft/i })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /confirm close/i }));
    expect(invoke).toHaveBeenCalledWith('close');
  });

  it('Escape cancels the Close confirm', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.keyboard('{Escape}');
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('non-Close actions invoke immediately (no confirm)', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /convert to draft/i }));
    expect(invoke).toHaveBeenCalledWith('convert-to-draft');
  });

  it('an external state change to closed clears an open Close confirm', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const open = makePrDetailDto({ pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }) });
    render(<Harness initial={{ prDetail: open }} ctl={ctl} />);
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    // peer closes the PR → context prDetail flips to closed
    const closed = makePrDetailDto({ pr: makePr({ state: 'closed', isClosed: true, isDraft: false, isMerged: false }) });
    act(() => ctl.current!.set({ prDetail: closed }));
    await waitFor(() => expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument());
  });

  it('renders nothing during cold load (no prDetail)', () => {
    // Plan ce-doc-review round 2 (feasibility): PrDetailContextValue.prDetail is typed non-null
    // (PrDetailDto), so `{ prDetail: null }` is a TS2322 under `tsc -b`. The Partial override makes
    // it `PrDetailDto | undefined`; use undefined. (The panel's `prDetail?.pr` guard is defensive —
    // the real provider always supplies prDetail since OverviewTab mounts only under loaded data.)
    const { container } = renderWithPrDetailContext(<PrActionsPanel />, { prDetail: undefined });
    expect(container).toBeEmptyDOMElement();
  });

  it('Close confirm moves focus to Cancel and exposes a status live-region', async () => {
    const user = userEvent.setup();
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveFocus();
    // live region, NOT a dialog role (inline morph, no focus trap):
    expect(screen.getByRole('status')).toHaveTextContent(/close this pr\?/i);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('a click outside the panel dismisses the Close confirm', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const open = makePrDetailDto({ pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }) });
    render(<Harness initial={{ prDetail: open }} ctl={ctl} />); // Harness mounts an "outside" button beside the panel
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /outside/i }));
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
  });

  it('the plain Close button shows the pending label while a close is in flight', () => {
    pending = 'close';
    renderPanel({});
    expect(screen.getByRole('button', { name: /closing…/i })).toBeInTheDocument();
  });

  it('a failed close clears the confirm back to the plain Close button', async () => {
    const user = userEvent.setup();
    // invoke('close') is mocked; the panel pre-clears confirm on Confirm-click, so after a
    // failure the confirm is already gone and the plain Close button is present.
    renderPanel({});
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    await user.click(screen.getByRole('button', { name: /confirm close/i }));
    expect(invoke).toHaveBeenCalledWith('close');
    expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument();
  });

  it('keeps focus inside the panel when the action set swaps after an action (no fall to body)', async () => {
    const user = userEvent.setup();
    const ctl: { current: Ctl | null } = { current: null };
    const openNonDraft = makePrDetailDto({ pr: makePr({ state: 'open', isClosed: false, isDraft: false, isMerged: false }) });
    render(<Harness initial={{ prDetail: openNonDraft }} ctl={ctl} />);
    // Click Convert-to-draft → onInvoke parks focus on the panel container (invoke is mocked, no POST).
    await user.click(screen.getByRole('button', { name: /convert to draft/i }));
    // The action's reconcile reload swaps the PR to draft → the set changes (Convert → Mark-ready),
    // removing the button that was clicked. Round-2 findings A2/D2: focus must NOT fall to <body>.
    const openDraft = makePrDetailDto({ pr: makePr({ state: 'open', isClosed: false, isDraft: true, isMerged: false }) });
    act(() => ctl.current!.set({ prDetail: openDraft }));
    expect(document.body).not.toHaveFocus();
    expect(screen.getByRole('group', { name: /pr actions/i })).toContainElement(document.activeElement as HTMLElement);
  });
});
```

> Test-harness notes: (1) the click-outside, external-state, and focus-on-swap tests use the `Harness` component defined at the top of the file (it swaps the context value via `useState` and mounts an "outside" button) — the simple `renderPanel` helper is fine for the static-render tests. (2) `toHaveFocus` / `toContainElement` require `@testing-library/jest-dom`. (3) For the pending-label test, the `usePrAction` mock exposes the module-level `pending` var — set it before render.

> Verify against the real codebase before coding: the provider export name in `prDetailContext.tsx` (the Harness assumes `PrDetailContextProvider`), `makePrDetailContextValue`'s arg shape in `testUtils.tsx` (assumed `Partial<PrDetailContextValue>`), and that `makePr`/`makePrDetailDto` accept `state/isDraft/isClosed/isMerged` (check `__tests__/helpers/prDetail.ts`). Adjust to whatever the source supports — do not invent an API.

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && node_modules/.bin/vitest run __tests__/PrActionsPanel.test.tsx`
Expected: FAIL — component not found.

- [ ] **Step 3: Implement the panel**

```tsx
// frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx
import { useEffect, useRef, useState } from 'react';
import { usePrDetailContext } from '../prDetailContext';
import { usePrAction, type PrActionKind } from '../../../hooks/usePrAction';
import styles from './PrActionsPanel.module.css';

// In-flight announcements for the visually-hidden live region (round-2 finding D3 — AT was silent
// during the write). Success-message copy (e.g. "Pull request closed") is a B1 a11y follow-up:
// the wording + the reopen-vs-ready ambiguity is an owner copy decision, not a mechanical fix.
const PENDING_ANNOUNCE: Record<PrActionKind, string> = {
  close: 'Closing pull request…',
  reopen: 'Reopening pull request…',
  ready: 'Marking ready for review…',
  'convert-to-draft': 'Converting to draft…',
};

export function PrActionsPanel() {
  const { prRef, prDetail, readOnly, reload } = usePrDetailContext();
  const pr = prDetail?.pr;
  // Pass the OBSERVED lifecycle state (not prDetail identity) so the fallback reconciles on THIS
  // action's target, immune to unrelated reloads (round-2 finding A1).
  const { pending, invoke } = usePrAction({
    prRef,
    reload,
    prState: pr ? { isClosed: pr.isClosed, isDraft: pr.isDraft } : undefined,
  });
  const [confirmingClose, setConfirmingClose] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Action-set visibility — computed BEFORE the suppression early-return so the focus-swap effect
  // (a hook) is unconditional (rules-of-hooks). `!!pr &&` guards the cold-load window.
  const showReopen = !!pr && pr.isClosed;
  const showClose = !!pr && !pr.isClosed;
  const showReady = !!pr && !pr.isClosed && pr.isDraft;
  const showConvertDraft = !!pr && !pr.isClosed && !pr.isDraft;
  const signature = `${showReady}|${showConvertDraft}|${showReopen}|${showClose}`;

  // Round-2 finding E: an external state change that alters the action set clears an open confirm.
  useEffect(() => {
    if (confirmingClose && (pr?.isClosed || pr?.isMerged)) setConfirmingClose(false);
  }, [pr?.isClosed, pr?.isMerged, confirmingClose]);

  // Focus the Cancel button when the confirm morph opens (a11y).
  useEffect(() => {
    if (confirmingClose) cancelRef.current?.focus();
  }, [confirmingClose]);

  // Focus-on-swap (round-2 findings A2/D2, folded inline per scope S4): when the visible action set
  // changes while focus is parked inside the panel, keep focus on the container instead of letting
  // it fall to <body>. This is RELIABLE here because every invoke/Confirm parks focus on the
  // container FIRST (onInvoke below) — so when the focused button is removed by the swap, focus is
  // already on the container, and `el.contains(activeElement)` is true. (The naive version read
  // activeElement AFTER removal, by which point it is already <body> and the guard fails.)
  const sigRef = useRef(signature);
  useEffect(() => {
    if (sigRef.current !== signature) {
      const el = containerRef.current;
      if (el && el.contains(document.activeElement)) el.focus();
      sigRef.current = signature;
    }
  }, [signature]);

  // Dismiss-on-click-outside (spec decision 2) — mirror ReviewActionMenu.tsx's mousedown pattern.
  useEffect(() => {
    if (!confirmingClose) return;
    const onDocMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setConfirmingClose(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [confirmingClose]);

  // Suppression: cold-load, readOnly, merged.
  if (!pr || readOnly || pr.isMerged) return null;

  const busy = pending !== null;
  const siblingsDisabled = busy || confirmingClose;

  // Nothing to show (defensive — merged already returned null).
  if (!showReopen && !showClose && !showReady && !showConvertDraft) return null;

  // Park focus on the container BEFORE invoking, so when the triggered button is removed by the
  // resulting set-swap (or the Confirm span unmounts) focus is already inside the panel and the
  // focus-swap effect can keep it there rather than the browser dropping it to <body>.
  const onInvoke = (kind: PrActionKind) => {
    containerRef.current?.focus();
    invoke(kind);
  };

  return (
    // tabIndex={-1} so the focus-swap effect can land focus on the panel when the button set changes.
    <div ref={containerRef} className={styles.panel} role="group" aria-label="PR actions" tabIndex={-1}>
      <span className={styles.regionTag}>PR actions</span>

      {/* Visually-hidden live region (NOT role="alertdialog" — that implies a modal w/ focus trap,
          which this inline morph is not; codebase uses Modal for alertdialog). Announces the
          confirm prompt AND the in-flight state. Pattern: AiFailureContainer / GitHubAuthBanner. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {confirmingClose
          ? 'Close this PR? Use Cancel or Confirm close.'
          : pending
            ? PENDING_ANNOUNCE[pending]
            : ''}
      </span>

      {showReady && (
        <button className={styles.btnReady} disabled={siblingsDisabled || pending === 'ready'} onClick={() => onInvoke('ready')}>
          {pending === 'ready' ? 'Marking ready…' : 'Ready for review'}
        </button>
      )}

      {showConvertDraft && (
        <button className={styles.btn} disabled={siblingsDisabled || pending === 'convert-to-draft'} onClick={() => onInvoke('convert-to-draft')}>
          {pending === 'convert-to-draft' ? 'Converting…' : 'Convert to draft'}
        </button>
      )}

      {showReopen && (
        <button className={styles.btnReopen} disabled={busy || pending === 'reopen'} onClick={() => onInvoke('reopen')}>
          {pending === 'reopen' ? 'Reopening…' : 'Reopen'}
        </button>
      )}

      {showClose && !confirmingClose && (
        // The pending label lives HERE (not on Confirm close): clicking Confirm sets
        // confirmingClose=false + pending='close' in one batch, so the confirm span unmounts and
        // the plain Close button is what renders during the in-flight state. (Plan ce-doc-review.)
        <button className={styles.btnClose} disabled={siblingsDisabled} onClick={() => setConfirmingClose(true)}>
          {pending === 'close' ? 'Closing…' : 'Close'}
        </button>
      )}

      {showClose && confirmingClose && (
        <span
          className={styles.confirm}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setConfirmingClose(false); } }}
        >
          <span className={styles.confirmQ}>Close this PR?</span>
          <button ref={cancelRef} className={styles.btn} onClick={() => setConfirmingClose(false)}>Cancel</button>
          <button
            className={styles.btnConfirm}
            // onInvoke parks focus on the container before the confirm span (and this button) unmount,
            // so the keyboard user is not dropped to <body> through the in-flight period.
            onClick={() => { onInvoke('close'); setConfirmingClose(false); }}
          >
            Confirm close
          </button>
        </span>
      )}
    </div>
  );
}
```

> Confirm the project's `sr-only` utility class name (search an existing visually-hidden usage, e.g. `AiFailureContainer.tsx` / `GitHubAuthBanner.tsx`) and use it verbatim. The click-outside `useEffect` mirrors `ReviewActionMenu.tsx`'s `mousedown` pattern — verify that file and match it.

`PrActionsPanel.module.css` — minimal structural styles (final visual polish deferred to the B1 gate):

```css
.panel {
  position: sticky;
  bottom: 0;
  display: flex;
  align-items: center;
  gap: var(--s-3);
  padding: var(--s-3) var(--s-4);
  border-top: 1px solid var(--border-0);
  background: var(--surface-0);
}
.regionTag { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; color: var(--text-muted); }
.btn, .btnReady, .btnReopen, .btnClose, .btnConfirm {
  font-size: 13px; padding: var(--s-2) var(--s-3); border-radius: 6px; cursor: pointer;
  border: 1px solid var(--border-0); background: var(--surface-1);
}
.btnClose { color: var(--danger-fg); }
.btnConfirm { background: var(--danger-fg); color: var(--surface-0); border-color: var(--danger-fg); }
.confirm { display: flex; align-items: center; gap: var(--s-2); margin-left: auto; }
.confirmQ { font-size: 13px; color: var(--danger-fg); font-weight: 600; }
button:disabled { opacity: 0.5; cursor: default; }
```

> Use the project's real token names (check an existing `.module.css` in `PrDetail/` for `--danger-fg`/`--border-0`/`--surface-*`/`--s-*`; substitute the actual names). The owner re-tunes visuals at the B1 gate — keep it functional and token-based, not pixel-perfect.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run __tests__/PrActionsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/OverviewTab/PrActionsPanel.tsx
git add frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.module.css frontend/__tests__/PrActionsPanel.test.tsx
git commit -m "feat(#566): PrActionsPanel state-aware lifecycle panel with inline Close confirm"
```

---

## Task 13: Wire it together (context `reload`, subscriber in PrDetailView, mount the panel)

**Files:**
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx` (wire `useLifecycleChangedSubscriber`; pass `reload` into context)
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` (mount `<PrActionsPanel />`)
- Test: `frontend/__tests__/PrDetailView.test.tsx` (or a new focused file) — the banner-suppression assertion below is **required**, not optional.

> The context `reload` field + the `makePrDetailContextValue` default were added in **Task 12 Step 0** (ordering fix). This task only wires the real provider value + the subscriber + mounts the panel.

**Interfaces:**
- Consumes: `useLifecycleChangedSubscriber` (Task 9), `PrActionsPanel` (Task 12), `PrDetailContextValue.reload` (Task 12 Step 0).

- [ ] **Step 1: Wire PrDetailView**

(a) Add the subscriber near the other reload subscribers (after `useSingleCommentPostedSubscriber`):

```typescript
// #566: reload PR detail when a lifecycle action (close/reopen/draft toggle) succeeds, and
// clear the transition latch first so the acting tab does NOT flash the "PR was closed —
// Reload" banner for its own action (mirrors handleReload's updates.clear() + reload()).
const handleLifecycleChanged = useCallback(() => {
  updates.clear();
  reload();
}, [updates, reload]);
useLifecycleChangedSubscriber({ prRef, onChanged: handleLifecycleChanged });
```

> `updates.clear` may not be referentially stable; if the existing code passes `updates.clear` directly elsewhere with an eslint-disable for the deps, follow that precedent. Verify `updates` is in scope at this point (it is — used by the transition banner).

(b) Add `reload` to the `ctxValue` memo (the `useMemo<PrDetailContextValue>` around line 398):

```typescript
    reload,
```

and add `reload` to that `useMemo`'s dependency array (it's a stable `useCallback` from `usePrDetail`).

- [ ] **Step 2: Mount the panel in OverviewTab**

In `OverviewTab.tsx` (after the Task 11 split), import and mount the panel as the grid's sibling:

```tsx
import { PrActionsPanel } from './PrActionsPanel';
// …
  return (
    <div className={styles.overviewTab} data-testid="overview-tab">
      <div className={styles.overviewGrid}>
        {/* …existing children… */}
      </div>
      <PrActionsPanel />
    </div>
  );
```

- [ ] **Step 3: REQUIRED test — self-action banner suppression (`updates.clear()` ordering)**

This is the specific guard the spec cited: the background `pr-updated` SSE latches `isClosed:true` on the acting tab, and without `updates.clear()` the user who clicked Close sees a redundant "PR was closed — Reload" banner. The `useLifecycleChangedSubscriber` unit test (Task 9) only checks `onChanged` fired — it cannot verify the `PrDetailView` wiring. Add a focused test in `frontend/__tests__/PrDetailView.test.tsx`:

```tsx
it('a self lifecycle action clears the update latch and does not flash the transition banner', async () => {
  // Render PrDetailView for an OPEN pr. Fire BOTH a background pr-updated{isClosed:true}
  // (latches updates.isClosed) AND the pr-lifecycle-changed SSE for the same pr.
  // Assert: the "PR was closed — Reload" BannerTransition is NOT shown (updates.clear ran),
  // and usePrDetail.reload was triggered (spy or assert the detail re-GET fired).
  // Wire via the existing PrDetailView test harness + the SSE-fire helper used elsewhere.
});
```

> If the existing `PrDetailView.test.tsx` harness can't easily fire SSE + spy `reload`, assert the observable instead: after firing `pr-updated{isClosed:true}` then `pr-lifecycle-changed`, `queryByText(/was closed.*reload/i)` is null. Match the real `BannerTransition` copy.

> **Residual race (round-2 adversarial A4 — deferred, documented).** `handleLifecycleChanged` does `updates.clear(); reload();`, but `updates` is an independent poller: if its next tick re-latches `isClosed` in the sub-second window *after* `clear()` but *before* the reload's `setData` flips `data.pr.isClosed` (which forces `transitionState` to null), the self-action banner can still flash briefly. The window is small and self-heals on the reload; a full fix (a short-lived "self-action in flight" flag gating the banner in `PrDetailView`) touches shared transition logic and is **not** in slice 1. Flag it for the owner at the B2 gate — if a flash is observed on a real self-Close, escalate to the flag fix.

- [ ] **Step 4: Run the FE gate**

Run: `cd frontend && node_modules/.bin/vitest run` (full suite)
Then: `cd frontend && node_modules/.bin/tsc -b` and `cd frontend && npm run lint`
Expected: green; no type errors; lint clean.

- [ ] **Step 5: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/PrDetailView.tsx src/components/PrDetail/OverviewTab/OverviewTab.tsx
git add frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx frontend/__tests__/PrDetailView.test.tsx
git commit -m "feat(#566): wire lifecycle subscriber + mount PrActionsPanel in Overview"
```

---

## Task 14: Full pre-push gate + live B2 verification prep

**Files:** none (verification task).

- [ ] **Step 1: Backend full build + test**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' build` then `& 'C:\Program Files\dotnet\dotnet.exe' test`
Expected: green. (If `AiUsageEndpointTests`/`InboxPoller within-500ms`/SSE-first-event flakes appear, re-run — they are known flakes unrelated to this change.)

- [ ] **Step 2: Frontend full gate**

Run: `cd frontend && node_modules/.bin/vitest run` ; `cd frontend && node_modules/.bin/tsc -b` ; `cd frontend && npm run lint`
Expected: all green.

- [ ] **Step 3: e2e wire-mock audit (no new GET wire field, but a NEW SSE event name)**

Grep `frontend/e2e` for any SSE event allowlist/mock that enumerates event names; if one exists, add `'pr-lifecycle-changed'`. (A non-optional wire field can escape route-mock bodies — but this slice adds no GET field; the only new wire surface is the SSE event name + the four POST routes.)

- [ ] **Step 4: Run `/simplify` (REQUIRED before PR)**

Per repo memory, run the simplify pass over the diff before pushing.

- [ ] **Step 5: B2 live-verification note for the owner (incl. error-string confirmation)**

Document in the PR `## Proof` section: CI cannot assert a real GitHub write. At the B2 gate, run against a real PR using the live PAT (serve detached, auth the local instance, open a real PR):
- **Happy path:** Close → Reopen → Mark-ready → Convert-to-draft — header glyph/badge reconcile without a manual refresh; no banner flash on self-Close.
- **Already-in-state (confirms the guessed GraphQL strings — plan ce-doc-review):** click **Mark-ready on an already-ready PR** and **Convert-to-draft on an already-draft PR** — assert **no error toast** (the benign-no-op detection matched GitHub's real message). If an error toast appears, capture the real response body and fix the match strings in `GitHubPrLifecycleWriter.FirstGraphQLErrorCode` before merge.
- **(If reachable) a branch-protected repo:** confirm the `repo-rule-blocked` copy doesn't advise changing the PAT.

- [ ] **Step 5b: Owner decisions to surface at the B1/B2 gate (round-2 ce-doc-review deferrals)**

Two findings were deferred to the owner rather than changed in the plan, because they are copy/UX judgment calls the spec already took a position on:
- **`token-cannot-write` toast persistence (design D4).** The spec committed all errors to `useToast` (transient). The `token-cannot-write` copy is ~180 chars naming two PAT grant paths + a collaborator caveat, and its remediation requires leaving PRism — a transient toast may dismiss before the user acts. At the B1 gate, decide whether *this one code* warrants a persistent/non-dismissing surface (the others are fine as toasts). No code change unless the owner asks.
- **Success announcement for AT (design D3).** The live region now announces the confirm prompt and the in-flight state; it does **not** announce success ("Pull request closed"). The wording — and the reopen-vs-mark-ready ambiguity when the post-state is "open" — is an owner copy decision. Flag at B1; add the success line only if the owner wants it.

- [ ] **Step 6: Final commit / ready for PR**

```bash
git add -A && git commit -m "chore(#566): pre-push gate green (backend + frontend + lint + typecheck)"
```

Then hand off to `pr-autopilot` (or `gh pr create` fallback) targeting `main`.

---

## Self-Review

**Spec coverage:**
- Update model (pending-reconcile) → Tasks 10, 12. ✓
- Per-action confirmation (Close inline two-step; others none) → Task 12. ✓
- Placement (adaptive sticky footer, Overview-only, state-aware, suppression) → Tasks 11, 12, 13. ✓
- `IPrLifecycleWriter` separate interface → Tasks 2, 3. ✓
- Reactive PAT + single combined copy + non-collaborator → Task 8 (codes), Task 10 (copy). ✓
- Toast error surface (`useToast`) → Task 10. ✓
- No GET wire change → confirmed; only POST routes + one SSE event. ✓
- Dedicated `PrLifecycleChanged` event + subscriber (NOT StateChanged) → Tasks 1, 5, 6, 9, 13. ✓
- Reconcile: pending clears on 200, observed-target-state-gated ~5s fallback → Task 10. ✓
- Self-Close banner suppression via `updates.clear()` → Task 13. ✓
- Re-entrancy guard + benign already-in-state no-op → Tasks 3, 10. ✓
- 403 classification (token/repo-rule/rate-limit) + reopen-422 + plan-unsupported → Task 3, mapped in Task 7. ✓
- CSRF custom-header parity → Task 7. ✓
- Server-side log before sanitize → Task 3 (writer Log) / Task 7 note. ✓
- Node-id via GraphQL resolver (no snapshot threading) → Task 3. ✓
- SSE hand-wiring + SSE-frame test → Task 6. ✓
- Focus-on-swap + external-state-clears-confirm a11y → Task 12. ✓
- DI in AddPrismGitHub → Task 4. ✓
- DOM split (overviewTab/overviewGrid same node today) → Task 11. ✓
- Acceptance criteria → covered across Tasks 3/7/10/12 tests + Task 14 live B2. ✓

**Placeholder scan:** No "TBD"/"implement later". Where the real codebase shape must be confirmed (ApiError fields, submit's exact tab-id helper + status, makePr fields, token CSS names, click-outside pattern), the step says so explicitly and points at the file to read — these are "match the real pattern" instructions, not deferred work.

**Type consistency:** `PrLifecycleErrorCode` (BE enum) ↔ kebab JSON `code` (in the response **body**) ↔ FE `PrLifecycleErrorCode` union align (token-cannot-write / repo-rule-blocked / reopen-not-possible / plan-unsupported-drafts / rate-limited / generic; FE adds `subscribe-rejected`, mapped from the **403 body code `"unauthorized"`** that `RequireSubscribed` emits — NOT from a status code). The FE reads the code from `e.body.code`, not `e.code`. `PrActionKind` ('close'|'reopen'|'ready'|'convert-to-draft') is consistent across Task 10 and Task 12. The reconcile signal is `prState: { isClosed, isDraft }` (observed PR state, NOT object identity), passed from Task 12's panel into Task 10's hook and reconciled via `reachedTarget(kind, prState)` — consistent across both. Event name `'pr-lifecycle-changed'` consistent across Tasks 6 + 9, registered in both `EventPayloadByType` and `EVENT_TYPES` (Task 9 Step 0).

**Round-1 plan ce-doc-review applied (6 personas):** FE error mapping `e.body.code` + 403 `"unauthorized"` (quadruple-corroborated); SSE `EVENT_TYPES` runtime registration; GraphQL mutation HTTP-error catch; a11y/interaction promoted into the skeleton (group+sr-only status, Close pending label, click-outside, focus-on-swap, Escape preventDefault); Task-ordering fix (context `reload` → Task 12 Step 0); primary-rate-limit 403; fallback arm-after-reload race note; provisional-error-string + B2 already-in-state step; endpoint `repo-rule-blocked` + 403-code tests; vacuous record test removed; bare-relative REST URL.

**Round-2 plan ce-doc-review applied (6 personas; security found nothing new):** **two verified false-tests fixed** — the unsubscribed endpoint test inherited `AllSubscribedActivePrCache` (gate could never reject → now a configurable cache + `SetSubscribed(false)`), and the missing-tab-id test got a valid tab-id from the client default (→ `CreateClient(tabId: null)`); cold-load test `prDetail: null` → `undefined` (TS2322 under `tsc -b`); **reconcile signal redesigned** from `prDetail` object-identity to observed-target-state (`reachedTarget`) so unrelated reloads can't disarm the SSE-drop fallback (adversarial A1); **focus marooning fixed at the source** by parking focus on the panel container at invoke/Confirm time (so the focus-swap effect's guard is valid — A2/D2), folded the focus helper inline (S4); live region now announces the in-flight state (D3); sticky-footer bottom clearance (D1); server-side log-entry assertion added (S1); all six `usePrAction` copy mappings tested (S2); `ConvertToDraft` mutation body pinned (S3); concrete state-swapping test `Harness` (C1/C2); writer block marked `partial` (F4); local `WaitFor` helper (F5); `{number:int:min(1)}` route constraint (A5). **Deferred (documented):** `updates.clear()` poll re-latch residual (A4) and the `token-cannot-write` toast-persistence / AT success-announcement copy decisions (D4/D3) — flagged for the owner at the B1/B2 gate.
