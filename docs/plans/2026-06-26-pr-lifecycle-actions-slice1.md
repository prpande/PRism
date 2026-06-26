# PR Lifecycle Actions — Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the reusable GitHub PR write-path foundation plus Close / Reopen / Mark-ready-for-review / Convert-to-draft, surfaced in an adaptive bottom-sticky panel in the Overview tab.

**Architecture:** A new `IPrLifecycleWriter` (impl `GitHubPrLifecycleWriter`) performs the GitHub writes (REST `PATCH …/pulls/{n}` for close/reopen; GraphQL `markPullRequestReadyForReview`/`convertPullRequestToDraft` for draft toggles, keyed by a GraphQL-resolved node id). Four `POST` endpoints gate on `RequireSubscribed` + the `X-PRism-Tab-Id` custom header, call the writer, classify failures into typed codes, and on success publish a new `PrLifecycleChanged` bus event. That event evicts the head-SHA-keyed snapshot (`PrDetailLoader.Invalidate`) and fans out over SSE; a new `useLifecycleChangedSubscriber` (mounted in `PrDetailView`) reloads PR detail. The frontend uses a `usePrAction` hook (pending-state-then-reconcile, synchronous re-entrancy guard, `prDetail`-identity-gated ~5s fallback) and a state-aware `PrActionsPanel` mounted as a full-width footer of a newly-split Overview DOM.

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

## Freshness-signal deviation (recorded per "document plan deviations durably")

The spec said pass `usePrDetail`'s "reload counter" into `usePrAction`. `usePrDetail` does **not** expose a counter — but `data` (→ `prDetail` in context) is replaced with a fresh object on every reload (`setData(result)`), including same-PR reloads. So this plan uses **`prDetail` object identity** as the freshness signal (cancel the fallback timer when the identity the panel holds changes after the POST). Same guarantee, no new field. Rationale logged here; mirror it in the implementing commit message.

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
- `frontend/src/hooks/usePrDetail.ts` — (no change needed; `reload` already exported; freshness via `data` identity).
- `frontend/src/components/PrDetail/prDetailContext.tsx` — add `reload` to context value + types.
- `frontend/src/components/PrDetail/PrDetailView.tsx` — wire `useLifecycleChangedSubscriber`; pass `reload` into context.
- `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` + `.module.css` — DOM split + mount panel.
- `frontend/src/components/PrDetail/testUtils.tsx` — add `reload` default to `makePrDetailContextValue`.

---

## Task 1: `PrLifecycleChanged` bus event

**Files:**
- Modify: `PRism.Core/Events/SubmitBusEvents.cs`
- Test: `tests/PRism.Core.Tests/Events/PrLifecycleChangedTests.cs` (create)

**Interfaces:**
- Produces: `public sealed record PrLifecycleChanged(PrReference PrRef) : IReviewEvent` — consumed by `PrDetailLoader`, `SseChannel`, `SseEventProjection`, `PrLifecycleEndpoints`.

- [ ] **Step 1: Write the failing test**

```csharp
// tests/PRism.Core.Tests/Events/PrLifecycleChangedTests.cs
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using Xunit;

namespace PRism.Core.Tests.Events;

public class PrLifecycleChangedTests
{
    [Fact]
    public void Carries_pr_ref_and_is_a_review_event()
    {
        var prRef = new PrReference("o", "r", 1);
        var evt = new PrLifecycleChanged(prRef);
        evt.PrRef.Should().Be(prRef);
        evt.Should().BeAssignableTo<IReviewEvent>();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Core.Tests --filter PrLifecycleChangedTests`
Expected: FAIL — `PrLifecycleChanged` does not exist.

- [ ] **Step 3: Add the record**

In `PRism.Core/Events/SubmitBusEvents.cs`, after the `SingleCommentPostedBusEvent` record (around line 55), add:

```csharp
// #566 — published after a successful PR lifecycle write (close / reopen / mark-ready /
// convert-to-draft). Like a comment post, a lifecycle change moves no head SHA, so the
// (prRef, headSha, generation) snapshot key would re-serve stale detail; the matching
// PrDetailLoader subscription evicts on this event. Fans out per-PR over SSE so the acting
// tab (and any peer tab on the PR) reloads. prRef only — the FE just needs the reload signal.
public sealed record PrLifecycleChanged(PrReference PrRef) : IReviewEvent;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Core.Tests --filter PrLifecycleChangedTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Events/SubmitBusEvents.cs tests/PRism.Core.Tests/Events/PrLifecycleChangedTests.cs
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

> **Note on transport:** `GitHubReviewSubmitter`'s `PostGraphQLAsync`/`SendGitHubAsync` are private instance wrappers — not shareable. Copy the same thin wrappers over the shared `internal static` `GitHubGraphQL.PostAsync` / `GitHubHttp.SendAsync` (the established "verbatim twin" pattern). The REST host base URL is `<host>/api/v3/`; build the pulls URL relative to it.

- [ ] **Step 1: Write the failing tests**

```csharp
// tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs
using System.Net;
using FluentAssertions;
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
}
```

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
internal sealed class GitHubPrLifecycleWriter : IPrLifecycleWriter
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
            // GitHub 403 secondary rate-limit / abuse bodies mention "secondary rate limit" / "abuse".
            if (body.Contains("secondary rate limit", StringComparison.OrdinalIgnoreCase)
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

    // ---- GraphQL draft toggles ----
    private async Task<PrLifecycleResult> RunDraftMutationAsync(PrReference reference, string mutation, CancellationToken ct)
    {
        string nodeId;
        try
        {
            nodeId = await ResolveNodeIdAsync(reference, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex)
        {
            Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", $"{mutation}:resolve", (int?)ex.StatusCode ?? 0, ex.Message);
            return PrLifecycleResult.Fail(PrLifecycleErrorCode.Generic);
        }

        var query = $$"""
            mutation($id: ID!) {
              {{mutation}}(input: { pullRequestId: $id }) {
                pullRequest { isDraft }
              }
            }
            """;
        var body = await PostGraphQLAsync(query, new { id = nodeId }, ct).ConfigureAwait(false);
        return ClassifyGraphQLResult(body, mutation, reference);
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

> If `GitHubPrLifecycleWriter` must be non-partial for the `Log` source-gen, mark the class `internal sealed partial class GitHubPrLifecycleWriter`. (Match the `GitHubReviewSubmitter` precedent — it is `partial`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.GitHub.Tests --filter GitHubPrLifecycleWriterTests`
Expected: PASS (all 9). If `Moq` is unavailable in `PRism.GitHub.Tests`, replace the factory mock with a tiny hand-rolled `IHttpClientFactory` stub class.

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

        await SseTestUtil.WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
        var subscriberId = channel.LatestSubscriberIdForCookieSession("c1")!;
        var prRef = new PrReference("o", "r", 1);
        registry.Add(subscriberId, prRef);

        bus.Publish(new PrLifecycleChanged(prRef));

        await SseTestUtil.WaitFor(() => !logger.Messages.IsEmpty, TimeSpan.FromSeconds(5));
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
        await SseTestUtil.WaitFor(() => subs.Current == 1, TimeSpan.FromSeconds(5));
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

> Reuse the existing `CapturingLogger` and `WaitFor` helpers from `SseChannelDraftSubmittedTests.cs`. If `WaitFor` is a private method there, copy it into a small `SseTestUtil` static or inline it (match whatever the existing SSE tests do — don't invent a helper that doesn't exist).

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
- Produces: `POST /api/pr/{owner}/{repo}/{number:int}/{close|reopen|ready-for-review|convert-to-draft}` returning 200 / `{code}` + status.

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

> Build the context by **copying `SubmitEndpointsTestContext`** and swapping `RemoveAll<IReviewSubmitter>()/AddSingleton(Submitter)` for `RemoveAll<IPrLifecycleWriter>()/AddSingleton(Writer)` (keep the `IReviewEventBus` + `IActivePrCache` + session-seed helpers; the lifecycle endpoint publishes a bus event and the test asserts on `Bus.Published`). Reuse `SeedSessionAsync`, `ValidSession`, `CreateClient`.

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
        using var client = ctx.CreateClient();

        var resp = await client.PostAsync("/api/pr/o/r/1/close", content: null); // no X-PRism-Tab-Id
        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity); // tab-id-missing (match submit's status)
        ctx.Writer.Calls.Should().BeEmpty();
    }

    [Fact]
    public async Task Unsubscribed_session_is_rejected()
    {
        using var ctx = PrLifecycleEndpointsTestContext.Create();
        // no SeedSessionAsync → not subscribed
        using var client = ctx.CreateClient();
        var resp = await client.SendAsync(Post("close"));
        resp.StatusCode.Should().NotBe(HttpStatusCode.OK);
        ctx.Writer.Calls.Should().BeEmpty();
    }
}
```

> Match the exact missing-tab-id status to what `…/submit` returns (the agent's notes say a distinct 422 `tab-id-missing`). If submit returns a different status, mirror it and update the assertion. Verify against `PrSubmitEndpoints.cs:120-123`.

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
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/close",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, ISubscriberRegistry subs, ILoggerFactory lf, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, subs, lf, ct, (w, r, c) => w.CloseAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/reopen",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, ISubscriberRegistry subs, ILoggerFactory lf, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, subs, lf, ct, (w, r, c) => w.ReopenAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/ready-for-review",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, ISubscriberRegistry subs, ILoggerFactory lf, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, subs, lf, ct, (w, r, c) => w.MarkReadyForReviewAsync(r, c), writer));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/convert-to-draft",
            (string owner, string repo, int number, HttpContext http, IPrLifecycleWriter writer, IReviewEventBus bus, ISubscriberRegistry subs, ILoggerFactory lf, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, subs, lf, ct, (w, r, c) => w.ConvertToDraftAsync(r, c), writer));
    }

    private static async Task<IResult> HandleAsync(
        string owner, string repo, int number, HttpContext http,
        IReviewEventBus bus, ISubscriberRegistry subs, ILoggerFactory lf, CancellationToken ct,
        Func<IPrLifecycleWriter, PrReference, CancellationToken, Task<PrLifecycleResult>> action,
        IPrLifecycleWriter writer)
    {
        var prRef = new PrReference(owner, repo, number);

        // CSRF parity + subscribe guard. Reuse the exact helpers the submit endpoint uses.
        if (!PrLifecycleGuards.HasValidTabId(http))
            return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);
        if (!PrLifecycleGuards.IsSubscribed(subs, prRef, http))
            return Results.Json(new { code = "not-subscribed" }, statusCode: StatusCodes.Status401Unauthorized);

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

> **Adapt the guard + DI seam to the real code.** The exact types — how `…/submit` reads/validates `X-PRism-Tab-Id`, and how it checks subscription (the agent referenced `RequireSubscribed` + `PrDetailEndpoints.TabIdAllowlistRegex()`) — must be matched verbatim, not invented. Read `PrSubmitEndpoints.cs:91-123` and reuse the SAME helper calls (replace the placeholder `PrLifecycleGuards.HasValidTabId`/`IsSubscribed` + `ISubscriberRegistry` with whatever submit actually uses). If submit reads the tab id via a shared helper, call that helper; do not duplicate the regex.

- [ ] **Step 3b: Map the endpoints**

At the endpoint-mapping site (where `MapPrSubmitEndpoints()` etc. are called), add:

```csharp
app.MapPrLifecycleEndpoints();
```

- [ ] **Step 4: Run to verify they pass**

Run: `& 'C:\Program Files\dotnet\dotnet.exe' test tests/PRism.Web.Tests --filter PrLifecycleEndpointsTests`
Expected: PASS (all 5).

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
vi.mock('./client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    code?: string;
    constructor(status: number, code?: string) { super(code); this.status = status; this.code = code; }
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

  it('maps a 403 token-cannot-write ApiError to a typed code', async () => {
    post.mockRejectedValueOnce(new ApiError(403, 'token-cannot-write'));
    const r = await closePr(prRef);
    expect(r).toEqual({ ok: false, code: 'token-cannot-write' });
  });

  it('maps a 422 reopen-not-possible from reopen', async () => {
    post.mockRejectedValueOnce(new ApiError(422, 'reopen-not-possible'));
    const r = await reopenPr(prRef);
    expect(r).toEqual({ ok: false, code: 'reopen-not-possible' });
  });

  it('falls back to generic for an unknown code', async () => {
    post.mockRejectedValueOnce(new ApiError(502, 'something-weird'));
    const r = await markReady(prRef);
    expect(r).toEqual({ ok: false, code: 'generic' });
  });

  it('maps a 401 to subscribe-rejected', async () => {
    post.mockRejectedValueOnce(new ApiError(401, 'not-subscribed'));
    const r = await convertToDraft(prRef);
    expect(r).toEqual({ ok: false, code: 'subscribe-rejected' });
  });
});
```

> Verify the real `ApiError` shape in `client.ts` (does it expose `.status` and a parsed `.code` from the JSON body?). The agent's excerpt cut off at "// error handling"; **read `client.ts`'s error path** and adjust the mock + the mapping to the actual fields. If the body code isn't parsed by `client.ts`, parse it in `prLifecycle.ts` from the error payload.

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
      // 401 from the subscribe guard → its own "session lost access" copy.
      if (e.status === 401) return { ok: false, code: 'subscribe-rejected' };
      const code = e.code && KNOWN.has(e.code) ? (e.code as PrLifecycleErrorCode) : 'generic';
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

## Task 9: `useLifecycleChangedSubscriber`

**Files:**
- Create: `frontend/src/hooks/useLifecycleChangedSubscriber.ts`
- Test: `frontend/src/hooks/useLifecycleChangedSubscriber.test.ts`

**Interfaces:**
- Consumes: `useEventSource`, `prRefKey` (mirror `useSingleCommentPostedSubscriber`). SSE event name `'pr-lifecycle-changed'` (Task 6).
- Produces: `useLifecycleChangedSubscriber({ prRef, onChanged }): void`.

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

> If `stream.on`'s event param is typed per-event, add `'pr-lifecycle-changed'` to that event-map type (find where `'single-comment-posted'` is declared for `useEventSource` and add the new entry with `{ prRef: string }`).

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
  - `interface UsePrActionArgs { prRef: PrReference; reload: () => void; freshness: unknown }` (`freshness` = the `prDetail` object identity the panel currently holds; changes when a reload lands).
  - `interface UsePrActionResult { pending: PrActionKind | null; invoke: (kind: PrActionKind) => void }`

- [ ] **Step 1: Write the failing tests**

```typescript
// frontend/src/hooks/usePrAction.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const closePr = vi.fn();
const markReady = vi.fn();
vi.mock('../api/prLifecycle', () => ({
  closePr: (...a: unknown[]) => closePr(...a),
  reopenPr: vi.fn(),
  markReady: (...a: unknown[]) => markReady(...a),
  convertToDraft: vi.fn(),
}));
const show = vi.fn();
vi.mock('../components/Toast/useToast', () => ({ useToast: () => ({ show, dismiss: vi.fn(), toasts: [] }) }));

import { usePrAction } from './usePrAction';

const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('usePrAction', () => {
  beforeEach(() => { closePr.mockReset(); markReady.mockReset(); show.mockReset(); vi.useRealTimers(); });

  it('sets pending then clears it on POST 200', async () => {
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    const reload = vi.fn();
    const { result } = renderHook(() => usePrAction({ prRef, reload, freshness: {} }));

    act(() => result.current.invoke('close'));
    expect(result.current.pending).toBe('close');

    await act(async () => { resolve({ ok: true }); });
    await waitFor(() => expect(result.current.pending).toBeNull());
  });

  it('re-entrancy guard ignores a second invoke while one is in flight', async () => {
    closePr.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), freshness: {} }));
    act(() => result.current.invoke('close'));
    act(() => result.current.invoke('close'));
    expect(closePr).toHaveBeenCalledTimes(1);
  });

  it('on failure clears pending and shows an error toast with mapped copy', async () => {
    closePr.mockResolvedValueOnce({ ok: false, code: 'token-cannot-write' });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), freshness: {} }));
    await act(async () => { result.current.invoke('close'); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(show.mock.calls[0][0].message).toMatch(/Pull requests: Read and write/);
  });

  it('does NOT show an error toast on a benign success', async () => {
    markReady.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), freshness: {} }));
    await act(async () => { result.current.invoke('ready'); });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).not.toHaveBeenCalled();
  });

  it('fires the fallback reload if freshness has not advanced within the timeout', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    const { result } = renderHook(() => usePrAction({ prRef, reload, freshness: {} }));
    await act(async () => { result.current.invoke('close'); });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('cancels the fallback when freshness changes (SSE reload landed)', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let freshness: object = { v: 1 };
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, freshness }));
    await act(async () => { result.current.invoke('close'); });
    // Simulate the SSE-driven reload swapping prDetail identity:
    freshness = { v: 2 };
    rerender();
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

export interface UsePrActionArgs {
  prRef: PrReference;
  reload: () => void;
  // The prDetail object identity the panel currently holds. A reload (SSE-driven or fallback)
  // replaces prDetail with a fresh object, changing this identity — that is the freshness signal
  // that cancels the fallback timer. (Deviation from the spec's "reload counter": same guarantee,
  // no new usePrDetail field — see the plan's freshness-signal deviation note.)
  freshness: unknown;
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

export function usePrAction({ prRef, reload, freshness }: UsePrActionArgs): UsePrActionResult {
  const [pending, setPending] = useState<PrActionKind | null>(null);
  const inFlight = useRef(false);                 // synchronous re-entrancy guard
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const freshnessAtPost = useRef<unknown>(undefined);
  const { show } = useToast();

  // Cancel the fallback timer when freshness advances (a reload landed).
  useEffect(() => {
    if (timerRef.current !== null && freshness !== freshnessAtPost.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, [freshness]);

  // Tidy the timer on unmount.
  useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); }, []);

  const invoke = useCallback(
    (kind: PrActionKind) => {
      if (inFlight.current) return;               // ignore double-clicks before pending commits
      inFlight.current = true;
      setPending(kind);
      freshnessAtPost.current = freshness;
      void ACTIONS[kind](prRef)
        .then((r) => {
          setPending(null);
          inFlight.current = false;
          if (!r.ok) {
            show({ kind: 'error', message: copyFor(r.code) });
            return;
          }
          // Success: arm the SSE-drop fallback. If freshness hasn't advanced by FALLBACK_MS,
          // the SSE reload was likely dropped — reload directly.
          if (timerRef.current !== null) clearTimeout(timerRef.current);
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            reload();
          }, FALLBACK_MS);
        })
        .catch(() => {
          setPending(null);
          inFlight.current = false;
          show({ kind: 'error', message: copyFor('generic') });
        });
    },
    [prRef, reload, freshness, show],
  );

  return { pending, invoke };
}
```

> The confirm-clear-on-external-state-change (decision 2 / round-2 finding E) lives in `PrActionsPanel` (Task 12), not here — the panel owns `isConfirming`.

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && node_modules/.bin/vitest run src/hooks/usePrAction.test.ts`
Expected: PASS (all 6).

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

In `OverviewTab.module.css`, keep `.overviewTab` as the scroller and `.overviewGrid` as the centered content column (they already carry the right rules — this split just stops applying both to one node). No rule changes needed; verify `.overviewTab` keeps `flex:1; overflow:auto` and `.overviewGrid` keeps `width: min(80%, …); margin:0 auto; padding; display:flex; flex-direction:column; gap`.

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
- Consumes: `usePrActionContext` data — `prDetail.pr` (`isDraft/isClosed/isMerged/state`), `readOnly`, `prRef`, `reload`, and `prDetail` (as `usePrAction`'s `freshness`). Reads these from `usePrDetailContext()` (after Task 13 adds `reload` to it). Uses `usePrAction` (Task 10).
- Produces: `export function PrActionsPanel(): JSX.Element | null`.

**Render rules (spec):** returns `null` when cold-load (no `prDetail`), `readOnly`, or merged. Otherwise renders the state-aware button set with the inline Close confirm.

- [ ] **Step 1: Write the failing tests**

```tsx
// frontend/__tests__/PrActionsPanel.test.tsx
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrActionsPanel } from '../src/components/PrDetail/OverviewTab/PrActionsPanel';
import { renderWithPrDetailContext } from '../src/components/PrDetail/testUtils';
import { makePr, makePrDetailDto } from './helpers/prDetail';

const invoke = vi.fn();
let pending: string | null = null;
vi.mock('../src/hooks/usePrAction', () => ({
  usePrAction: () => ({ pending, invoke }),
}));

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
    const open = makePrDetailDto({ pr: makePr({ state: 'open', isClosed: false }) });
    const { rerender } = renderWithPrDetailContext(<PrActionsPanel />, { prDetail: open });
    await user.click(screen.getByRole('button', { name: /^close$/i }));
    expect(screen.getByText(/close this pr\?/i)).toBeInTheDocument();
    // peer closes the PR → context prDetail flips to closed
    const closed = makePrDetailDto({ pr: makePr({ state: 'closed', isClosed: true }) });
    rerender(/* re-render with closed context — see note */);
    await waitFor(() => expect(screen.queryByText(/close this pr\?/i)).not.toBeInTheDocument());
  });
});
```

> `renderWithPrDetailContext` returns a plain RTL result; to re-render with a new context value, either expose a small wrapper that takes the value as state, or re-`render` into the same container. If `rerender` with a new provider value is awkward, restructure the last test to mount a tiny harness component that swaps the context value via `useState`. Adjust to whatever `testUtils.tsx` supports — do not invent an API. Confirm `makePr`/`makePrDetailDto` accept the `state/isDraft/isClosed/isMerged` fields (check `__tests__/helpers/prDetail.ts`).

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

export function PrActionsPanel() {
  const { prRef, prDetail, readOnly, reload } = usePrDetailContext();
  const { pending, invoke } = usePrAction({ prRef, reload, freshness: prDetail });
  const [confirmingClose, setConfirmingClose] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const pr = prDetail?.pr;

  // Round-2 finding E: an external state change that alters the action set clears an open confirm.
  useEffect(() => {
    if (confirmingClose && (pr?.isClosed || pr?.isMerged)) setConfirmingClose(false);
  }, [pr?.isClosed, pr?.isMerged, confirmingClose]);

  // Focus the Cancel button when the confirm morph opens (a11y).
  useEffect(() => {
    if (confirmingClose) cancelRef.current?.focus();
  }, [confirmingClose]);

  // Suppression: cold-load, readOnly, merged.
  if (!pr || readOnly || pr.isMerged) return null;

  const busy = pending !== null;
  const siblingsDisabled = busy || confirmingClose;

  // Derive the visible action set.
  const showReopen = pr.isClosed;
  const showClose = !pr.isClosed;
  const showReady = !pr.isClosed && pr.isDraft;
  const showConvertDraft = !pr.isClosed && !pr.isDraft;

  // Nothing to show (defensive — merged already returned null).
  if (!showReopen && !showClose && !showReady && !showConvertDraft) return null;

  const onInvoke = (kind: PrActionKind) => invoke(kind);

  return (
    <div ref={containerRef} className={styles.panel} role="group" aria-label="PR actions">
      <span className={styles.regionTag}>PR actions</span>

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
        <button className={styles.btnClose} disabled={siblingsDisabled} onClick={() => setConfirmingClose(true)}>
          Close
        </button>
      )}

      {showClose && confirmingClose && (
        <span
          className={styles.confirm}
          role="alertdialog"
          aria-live="polite"
          onKeyDown={(e) => { if (e.key === 'Escape') setConfirmingClose(false); }}
        >
          <span className={styles.confirmQ}>Close this PR?</span>
          <button ref={cancelRef} className={styles.btn} onClick={() => setConfirmingClose(false)}>Cancel</button>
          <button
            className={styles.btnConfirm}
            disabled={pending === 'close'}
            onClick={() => { setConfirmingClose(false); onInvoke('close'); }}
          >
            {pending === 'close' ? 'Closing…' : 'Confirm close'}
          </button>
        </span>
      )}
    </div>
  );
}
```

> **Dismiss-on-click-outside** (spec decision 2): add a `useEffect` that, while `confirmingClose`, registers a `mousedown` document listener that calls `setConfirmingClose(false)` when the target is outside `containerRef`. Mirror any existing click-outside pattern in the codebase (search for one before hand-rolling). **Focus-on-swap** (finding M): when the action set changes after a successful reload, move focus into the panel — a `useEffect` keyed on the derived action-set signature that calls `containerRef.current?.focus()` (give the container `tabIndex={-1}`) when the set changes and the panel previously held focus. Keep it minimal; the exact focus-on-swap is gate-tunable but include a working version.

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
- Modify: `frontend/src/components/PrDetail/prDetailContext.tsx` (add `reload` to the value + type)
- Modify: `frontend/src/components/PrDetail/testUtils.tsx` (add `reload` default)
- Modify: `frontend/src/components/PrDetail/PrDetailView.tsx` (wire `useLifecycleChangedSubscriber`; pass `reload` into context)
- Modify: `frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx` (mount `<PrActionsPanel />`)
- Test: a focused integration test in `frontend/__tests__/` is optional; the unit tests above + the existing PrDetailView tests cover the seams. Add one assertion to an existing PrDetailView test if it already renders the SSE wiring.

**Interfaces:**
- Consumes: `useLifecycleChangedSubscriber` (Task 9), `PrActionsPanel` (Task 12). Produces: `PrDetailContextValue.reload: () => void`.

- [ ] **Step 1: Add `reload` to the context type + provider value**

In `prDetailContext.tsx`, add to `PrDetailContextValue`:

```typescript
  // #566 — lets the Overview PrActionsPanel trigger a PR-detail reload (SSE-drop fallback).
  reload: () => void;
```

- [ ] **Step 2: Update `makePrDetailContextValue` default**

In `testUtils.tsx`, add to the returned object (so every `renderWithPrDetailContext` test still typechecks):

```typescript
    reload: vi.fn(),
```

- [ ] **Step 3: Wire PrDetailView**

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

- [ ] **Step 4: Mount the panel in OverviewTab**

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

- [ ] **Step 5: Run the FE gate**

Run: `cd frontend && node_modules/.bin/vitest run` (full suite)
Then: `cd frontend && node_modules/.bin/tsc -b` and `cd frontend && npm run lint`
Expected: green; no type errors; lint clean.

- [ ] **Step 6: Prettier + commit**

```bash
cd frontend && node_modules/.bin/prettier --write src/components/PrDetail/prDetailContext.tsx src/components/PrDetail/PrDetailView.tsx src/components/PrDetail/OverviewTab/OverviewTab.tsx src/components/PrDetail/testUtils.tsx
git add frontend/src/components/PrDetail/prDetailContext.tsx frontend/src/components/PrDetail/PrDetailView.tsx frontend/src/components/PrDetail/OverviewTab/OverviewTab.tsx frontend/src/components/PrDetail/testUtils.tsx
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

- [ ] **Step 5: B2 live-verification note for the owner**

Document in the PR `## Proof` section: CI cannot assert a real GitHub write. The owner must, at the B2 gate, run a real Close → Reopen → Mark-ready → Convert-to-draft against a real PR using the live PAT (per the reference recipe: serve detached, auth the local instance, open a real PR), confirming the header glyph/badge reconcile without a manual refresh and no banner flash on self-Close.

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
- Reconcile: pending clears on 200, freshness-gated ~5s fallback → Task 10. ✓
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

**Type consistency:** `PrLifecycleErrorCode` (BE enum) ↔ kebab JSON `code` ↔ FE `PrLifecycleErrorCode` union align (token-cannot-write / repo-rule-blocked / reopen-not-possible / plan-unsupported-drafts / rate-limited / generic; FE adds subscribe-rejected from 401). `PrActionKind` ('close'|'reopen'|'ready'|'convert-to-draft') is consistent across Task 10 and Task 12. `freshness: unknown` = `prDetail` identity, used consistently in Tasks 10 + 12. Event name `'pr-lifecycle-changed'` consistent across Tasks 6 + 9.
