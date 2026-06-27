# PR Lifecycle Merge (#566 Slice 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a state-aware, two-step "Merge" action to the PR-detail Overview panel that merges a PR via GitHub with a repo-allowed merge-method choice, a mandatory head-SHA staleness guard, and reconcile/error paths tuned for merge latency.

**Architecture:** Extends the slice-1 lifecycle seam verbatim (endpoint → `IPrLifecycleWriter` → `PrLifecycleChanged` → `PrDetailLoader.Invalidate` → SSE → `usePrDetail.reload()`). Net-new substrate: a REST `MergeAsync` writer method, two new error codes with reconcile-before-toast handling, and three repo-allowed-method fields on the PR-detail GraphQL query. UI is an inline two-step morph in `PrActionsPanel` reusing the slice-1 Close pattern, with a new `MergeMethodPicker` subcomponent.

**Tech Stack:** .NET 10 (PRism.Core / PRism.GitHub / PRism.Web), xUnit + FluentAssertions; React + Vite + TypeScript, vitest + Testing Library.

**Spec:** `docs/specs/2026-06-27-pr-lifecycle-merge-design.md` (read it before starting).

## Global Constraints

- **TDD:** every behavior change is test-first (write failing test → confirm fail → minimal impl → confirm pass → commit).
- **Backend tests:** run with the real `dotnet.exe`, never via rtk. `dotnet test` timeout ≥ 300000ms. One build/test command at a time.
- **Frontend tests:** run vitest via the local binary `frontend/node_modules/.bin/vitest`, NOT `npx vitest` (npx grabs a cached jsdom-ignoring binary). Typecheck with `tsc -b`, never `tsc --noEmit`.
- **Prettier:** new/changed FE files must pass `npm run lint` (prettier `--check` gates CI). `eslint no-unused-vars` ignores `_`-prefixed names.
- **Enum wire form:** backend enums serialize kebab-case via `JsonStringEnumConverter`; FE unions must match exactly.
- **GitHub merge wire values:** `merge_method` ∈ `{ "merge", "squash", "rebase" }` exactly (ordinal, case-exact).
- **Reconcile window constant:** `MERGE_RECONCILE_MS = 10_000` is the single window for all merge reconcile/fallback paths.
- **No secrets** in any commit. Commit messages end with the repo's Co-Authored-By + Claude-Session trailers.
- **Pre-push checklist** (`.ai/docs/development-process.md`) runs verbatim before any push.

---

## File Structure

**Backend**
- `PRism.Core/IPrLifecycleWriter.cs` — add `MergeAsync` + `MergeMethod` enum + 2 error codes (modify).
- `PRism.Core.Contracts/Pr.cs` — add `AllowedMergeMethods` record + `Pr.AllowedMergeMethods` field (modify).
- `PRism.GitHub/GitHubPrLifecycleWriter.cs` — `MergeAsync` (REST PUT) + `ClassifyMergeFailure` (modify).
- `PRism.GitHub/GitHubReviewService.cs` — 3 fields on `PrDetailGraphQLQuery` + parse at the call site (modify).
- `PRism.Web/Endpoints/PrLifecycleEndpoints.cs` — `/merge` route + `MergeRequest` DTO + validation + error map (modify).

**Frontend**
- `frontend/src/api/prLifecycle.ts` — `mergePr` + 2 error codes (modify).
- `frontend/src/api/types.ts` — `PrDetailPr.allowedMergeMethods` + `AllowedMergeMethods` type (modify).
- `frontend/src/hooks/usePrAction.ts` — `'merge'` kind, `isMerged`, `mergePhase`, merge reconcile (modify).
- `frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.tsx` — new radiogroup subcomponent (create).
- `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx` — merge affordance, gating, focus/a11y (modify).
- `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.module.css` — merge styles (modify).
- `frontend/src/components/PrDetail/prDetailContext` — confirm the live-region host for the "Pull request merged" announcement (verify; see Task 9).

**Tests**
- `tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs` (modify)
- `tests/PRism.GitHub.Tests/…GraphQlByteIdentity…` pin test (modify — locate via grep)
- `tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs` + `TestHelpers/PrLifecycleEndpointsTestContext.cs` (modify)
- `tests/PRism.GitHub.Tests/…` parser test for allowed-methods (modify/create — locate the ParsePr/GetPrDetail test)
- `frontend/src/api/prLifecycle.test.ts` (modify/create)
- `frontend/src/hooks/usePrAction.test.ts` (modify)
- `frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.test.tsx` (create)
- `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx` (modify — locate existing)

---

## Task 1: Core contracts — MergeMethod, error codes, interface, Pr field, fakes compile

**Files:**
- Modify: `PRism.Core/IPrLifecycleWriter.cs`
- Modify: `PRism.Core.Contracts/Pr.cs`
- Modify: `tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs` (`TestPrLifecycleWriter`)
- Modify: any other `IPrLifecycleWriter` implementer/fake (grep first)

**Interfaces:**
- Produces: `enum MergeMethod { Merge, Squash, Rebase }`; `PrLifecycleErrorCode.MergeNotMergeable`, `.MergeHeadChanged`; `Task<PrLifecycleResult> IPrLifecycleWriter.MergeAsync(PrReference, MergeMethod, string?, CancellationToken)`; `record AllowedMergeMethods(bool Merge, bool Squash, bool Rebase)`; `Pr.AllowedMergeMethods` (default `new(true, true, true)`).

This task's deliverable is "the solution compiles and all existing tests still pass" — a reviewable contract surface. No new behavior test yet.

- [ ] **Step 1: Grep for every `IPrLifecycleWriter` implementer**

Run: `Grep pattern ": IPrLifecycleWriter" glob "*.cs"`
Expected: `GitHubPrLifecycleWriter` (prod) + `TestPrLifecycleWriter` (test). Note any others to update.

- [ ] **Step 2: Add `MergeMethod` enum and error codes to `IPrLifecycleWriter.cs`**

Add the enum above the interface and extend `PrLifecycleErrorCode`:

```csharp
// GitHub PUT /pulls/{n}/merge merge_method values. Mapped to the wire strings at the writer.
public enum MergeMethod { Merge, Squash, Rebase }
```

Add the interface method (inside `IPrLifecycleWriter`, after `ConvertToDraftAsync`):

```csharp
    // REST PUT /repos/{o}/{r}/pulls/{n}/merge { merge_method, sha }. 405 → MergeNotMergeable
    // (not mergeable / method disallowed), 409 → MergeHeadChanged (head moved / conflict).
    // expectedHeadSha is the SHA the UI rendered; the endpoint guarantees it non-empty.
    Task<PrLifecycleResult> MergeAsync(
        PrReference reference, MergeMethod method, string? expectedHeadSha, CancellationToken ct);
```

Add to the `PrLifecycleErrorCode` enum (before `Generic`):

```csharp
    MergeNotMergeable,     // merge 405/422 — checks/protection/method changed; can't merge now
    MergeHeadChanged,      // merge 409 — head moved since load (stale sha) or merge conflict
```

- [ ] **Step 3: Add `AllowedMergeMethods` to `Pr.cs`**

Add the record (after the `Pr` record) and a field on `Pr` (append as the last optional parameter so existing positional constructions are unaffected):

```csharp
// Repo-allowed merge methods (Repository.mergeCommitAllowed/squashMergeAllowed/rebaseMergeAllowed).
// Default all-true so a parse miss degrades to "offer all, let GitHub 405" rather than merge-only.
public sealed record AllowedMergeMethods(bool Merge, bool Squash, bool Rebase);
```

In the `Pr` primary constructor, append after `AwaitingReviewers`:

```csharp
    IReadOnlyList<Reviewer>? AwaitingReviewers = null,
    AllowedMergeMethods? AllowedMergeMethods = null);
```

(Null means "not parsed"; the parser/serialization layer defaults it — see Task 4 / FE Task 6. Keeping it nullable avoids forcing every `Pr` test construction to pass it.)

- [ ] **Step 4: Implement `MergeAsync` on `TestPrLifecycleWriter`**

In `PrLifecycleEndpointsTestContext.cs`, extend the fake to record method + sha (later tasks assert these). Replace the `Calls` list usage with a richer record:

```csharp
internal sealed class TestPrLifecycleWriter : IPrLifecycleWriter
{
    public PrLifecycleResult NextResult { get; set; } = PrLifecycleResult.Ok;
    public List<string> Calls { get; } = new();
    public (MergeMethod Method, string? Sha)? LastMerge { get; private set; }

    private Task<PrLifecycleResult> Record(string verb)
    {
        Calls.Add(verb);
        return Task.FromResult(NextResult);
    }

    public Task<PrLifecycleResult> CloseAsync(PrReference r, CancellationToken ct) => Record("close");
    public Task<PrLifecycleResult> ReopenAsync(PrReference r, CancellationToken ct) => Record("reopen");
    public Task<PrLifecycleResult> MarkReadyForReviewAsync(PrReference r, CancellationToken ct) => Record("ready");
    public Task<PrLifecycleResult> ConvertToDraftAsync(PrReference r, CancellationToken ct) => Record("draft");

    public Task<PrLifecycleResult> MergeAsync(PrReference r, MergeMethod method, string? expectedHeadSha, CancellationToken ct)
    {
        LastMerge = (method, expectedHeadSha);
        return Record("merge");
    }
}
```

- [ ] **Step 5: Stub `MergeAsync` on the prod writer so it compiles (real impl in Task 2)**

In `GitHubPrLifecycleWriter.cs`, add a temporary throwing stub (Task 2 replaces it):

```csharp
    public Task<PrLifecycleResult> MergeAsync(PrReference reference, MergeMethod method, string? expectedHeadSha, CancellationToken ct) =>
        throw new NotImplementedException("Task 2");
```

- [ ] **Step 6: Build the solution and run the existing lifecycle tests**

Run: `dotnet build PRism.sln`
Expected: builds with no CS0535 (interface fully implemented everywhere).
Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~Lifecycle" -v minimal`
Expected: existing lifecycle tests PASS (no behavior changed).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/IPrLifecycleWriter.cs PRism.Core.Contracts/Pr.cs PRism.GitHub/GitHubPrLifecycleWriter.cs tests/PRism.Web.Tests/TestHelpers/PrLifecycleEndpointsTestContext.cs
git commit -m "feat(#566): merge contracts — MergeMethod, error codes, IPrLifecycleWriter.MergeAsync, AllowedMergeMethods"
```

---

## Task 2: `GitHubPrLifecycleWriter.MergeAsync` — REST PUT + classification

**Files:**
- Modify: `PRism.GitHub/GitHubPrLifecycleWriter.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs`

**Interfaces:**
- Consumes: `GitHubHttp.SendAsync(http, HttpMethod.Put, url, token, ct, content)`, `GitHubHttp.ReadErrorBodyBestEffortAsync`, `PrLifecycleResult.Ok/Fail`.
- Produces: real `MergeAsync` issuing `PUT repos/{o}/{r}/pulls/{n}/merge` with body `{ "merge_method": <wire>, "sha": <sha> }` (sha omitted when null), classified by `ClassifyMergeFailure`.

- [ ] **Step 1: Write the failing test — PUT shape with merge_method + sha**

Add to `GitHubPrLifecycleWriterTests.cs`:

```csharp
[Fact]
public async Task MergeAsync_issues_PUT_merge_with_method_and_sha()
{
    var handler = new StubHandler(Resp(HttpStatusCode.OK, "{\"merged\":true}"));
    var writer = MakeWriter(handler);

    var result = await writer.MergeAsync(Pr, MergeMethod.Squash, "abc123", CancellationToken.None);

    result.Success.Should().BeTrue();
    handler.Requests.Should().ContainSingle();
    handler.Requests[0].Method.Should().Be(HttpMethod.Put);
    handler.Requests[0].Url.Should().EndWith("/repos/o/r/pulls/1/merge");
    handler.Requests[0].Body.Should().Contain("\"merge_method\":\"squash\"");
    handler.Requests[0].Body.Should().Contain("\"sha\":\"abc123\"");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "MergeAsync_issues_PUT_merge_with_method_and_sha" -v minimal`
Expected: FAIL with `NotImplementedException("Task 2")`.

- [ ] **Step 3: Implement `MergeAsync` + `ClassifyMergeFailure`**

Replace the Task-1 stub in `GitHubPrLifecycleWriter.cs` with:

```csharp
    private static string WireMethod(MergeMethod m) => m switch
    {
        MergeMethod.Squash => "squash",
        MergeMethod.Rebase => "rebase",
        _ => "merge",
    };

    public async Task<PrLifecycleResult> MergeAsync(
        PrReference reference, MergeMethod method, string? expectedHeadSha, CancellationToken ct)
    {
        var url = $"repos/{reference.Owner}/{reference.Repo}/pulls/{reference.Number}/merge";
        // Structured serialization (no commit_title/commit_message → GitHub default). sha omitted when null.
        object payload = string.IsNullOrEmpty(expectedHeadSha)
            ? new { merge_method = WireMethod(method) }
            : new { merge_method = WireMethod(method), sha = expectedHeadSha };
        using var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
        using var http = _httpFactory.CreateClient("github");
        var token = await _readToken().ConfigureAwait(false);
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Put, url, token, ct, content).ConfigureAwait(false);
        if (resp.IsSuccessStatusCode) return PrLifecycleResult.Ok;

        var body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
        var code = ClassifyMergeFailure(resp.StatusCode, body);
        Log.LifecycleFailed(_log, $"{reference.Owner}/{reference.Repo}#{reference.Number}", "merge", (int)resp.StatusCode, GitHubHttp.Truncate(body, 1024));
        return PrLifecycleResult.Fail(code);
    }

    private static PrLifecycleErrorCode ClassifyMergeFailure(HttpStatusCode status, string body)
    {
        if (status == HttpStatusCode.TooManyRequests) return PrLifecycleErrorCode.RateLimited;
        if (status == HttpStatusCode.MethodNotAllowed) return PrLifecycleErrorCode.MergeNotMergeable; // 405
        if (status == HttpStatusCode.Conflict) return PrLifecycleErrorCode.MergeHeadChanged;          // 409
        if (status == HttpStatusCode.UnprocessableEntity) return PrLifecycleErrorCode.MergeNotMergeable; // 422 required checks/validation
        if (status == HttpStatusCode.Forbidden)
        {
            if (body.Contains("rate limit", StringComparison.OrdinalIgnoreCase)
                || body.Contains("abuse", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RateLimited;
            if (body.Contains("Protected branch", StringComparison.OrdinalIgnoreCase))
                return PrLifecycleErrorCode.RepoRuleBlocked;
            return PrLifecycleErrorCode.TokenCannotWrite;
        }
        return PrLifecycleErrorCode.Generic;
    }
```

- [ ] **Step 4: Run the PUT-shape test — verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "MergeAsync_issues_PUT_merge_with_method_and_sha" -v minimal`
Expected: PASS.

- [ ] **Step 5: Write the classification tests**

```csharp
[Fact]
public async Task MergeAsync_omits_sha_when_headSha_null()
{
    var handler = new StubHandler(Resp(HttpStatusCode.OK, "{\"merged\":true}"));
    await MakeWriter(handler).MergeAsync(Pr, MergeMethod.Merge, null, CancellationToken.None);
    handler.Requests[0].Body.Should().NotContain("sha");
    handler.Requests[0].Body.Should().Contain("\"merge_method\":\"merge\"");
}

[Theory]
[InlineData(HttpStatusCode.MethodNotAllowed, "{\"message\":\"Pull Request is not mergeable\"}", PrLifecycleErrorCode.MergeNotMergeable)]
[InlineData(HttpStatusCode.Conflict, "{\"message\":\"Head branch was modified. Review and try the merge again.\"}", PrLifecycleErrorCode.MergeHeadChanged)]
[InlineData(HttpStatusCode.UnprocessableEntity, "{\"message\":\"Required status check failed\"}", PrLifecycleErrorCode.MergeNotMergeable)]
[InlineData(HttpStatusCode.TooManyRequests, "{}", PrLifecycleErrorCode.RateLimited)]
public async Task MergeAsync_classifies_failures(HttpStatusCode status, string body, PrLifecycleErrorCode expected)
{
    var handler = new StubHandler(Resp(status, body));
    var result = await MakeWriter(handler).MergeAsync(Pr, MergeMethod.Merge, "sha", CancellationToken.None);
    result.ErrorCode.Should().Be(expected);
}

[Fact]
public async Task MergeAsync_403_protected_branch_maps_to_RepoRuleBlocked()
{
    var handler = new StubHandler(Resp(HttpStatusCode.Forbidden, "{\"message\":\"Protected branch update failed\"}"));
    var result = await MakeWriter(handler).MergeAsync(Pr, MergeMethod.Merge, "sha", CancellationToken.None);
    result.ErrorCode.Should().Be(PrLifecycleErrorCode.RepoRuleBlocked);
}

[Fact]
public async Task MergeAsync_403_default_maps_to_TokenCannotWrite()
{
    var handler = new StubHandler(Resp(HttpStatusCode.Forbidden, "{\"message\":\"Resource not accessible by personal access token\"}"));
    var result = await MakeWriter(handler).MergeAsync(Pr, MergeMethod.Merge, "sha", CancellationToken.None);
    result.ErrorCode.Should().Be(PrLifecycleErrorCode.TokenCannotWrite);
}
```

- [ ] **Step 6: Run all writer tests — verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~GitHubPrLifecycleWriterTests" -v minimal`
Expected: PASS (existing + new).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/GitHubPrLifecycleWriter.cs tests/PRism.GitHub.Tests/GitHubPrLifecycleWriterTests.cs
git commit -m "feat(#566): GitHubPrLifecycleWriter.MergeAsync REST PUT + failure classification"
```

---

## Task 3: `/merge` endpoint — DTO, headSha-required 400, method allowlist 400, error map

**Files:**
- Modify: `PRism.Web/Endpoints/PrLifecycleEndpoints.cs`
- Test: `tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs`

**Interfaces:**
- Consumes: `IPrLifecycleWriter.MergeAsync`, `RequireSubscribed.Check`, `PrDetailEndpoints.TabIdAllowlistRegex()`, `bus.Publish(new PrLifecycleChanged(prRef))`.
- Produces: `POST /api/pr/{owner}/{repo}/{number:int:min(1)}/merge` reading `MergeRequest { string Method, string HeadSha }`; 400 on missing/empty `HeadSha` or method ∉ `{merge,squash,rebase}`; maps `MergeNotMergeable`→422 `merge-not-mergeable`, `MergeHeadChanged`→409 `merge-head-changed`.

- [ ] **Step 1: Write the failing happy-path test (merge succeeds, records method+sha, publishes)**

Add a body-posting helper + test to `PrLifecycleEndpointsTests.cs`:

```csharp
private static HttpRequestMessage PostMerge(object body) =>
    new(HttpMethod.Post, "/api/pr/o/r/1/merge")
    {
        Headers = { { "X-PRism-Tab-Id", "tab-123" } },
        Content = JsonContent.Create(body),
    };

[Fact]
public async Task Merge_success_records_method_sha_and_publishes()
{
    using var ctx = PrLifecycleEndpointsTestContext.Create();
    await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
    ctx.Writer.NextResult = PrLifecycleResult.Ok;
    using var client = ctx.CreateClient();

    var resp = await client.SendAsync(PostMerge(new { method = "squash", headSha = "abc123" }));

    resp.StatusCode.Should().Be(HttpStatusCode.OK);
    ctx.Writer.Calls.Should().ContainSingle().Which.Should().Be("merge");
    ctx.Writer.LastMerge.Should().Be((MergeMethod.Squash, "abc123"));
    await TestPoll.UntilAsync(
        () => ctx.Bus.Published.OfType<PrLifecycleChanged>().Any(),
        TimeSpan.FromSeconds(5), "PrLifecycleChanged should publish");
}
```

- [ ] **Step 2: Run — verify fail**

Run: `dotnet test tests/PRism.Web.Tests --filter "Merge_success_records_method_sha_and_publishes" -v minimal`
Expected: FAIL (route 404 / not mapped).

- [ ] **Step 3: Add the route, DTO, validation, and error-map entries**

In `PrLifecycleEndpoints.cs`, add the DTO (top of the static class) and the route. Because merge needs a request body + per-field validation, it does NOT reuse the parameterless `HandleAsync`; give it its own handler.

```csharp
    // Ordinal, case-exact allowlist — NOT a JsonStringEnumConverter bind, which is permissive
    // (accepts "Merge", "1"); see stj-enum-converter-permissive. Returns null on an invalid value.
    private static MergeMethod? ParseMethod(string? raw) => raw switch
    {
        "merge" => MergeMethod.Merge,
        "squash" => MergeMethod.Squash,
        "rebase" => MergeMethod.Rebase,
        _ => null,
    };

    private sealed record MergeRequest(string? Method, string? HeadSha);
```

Add the route inside `MapPrLifecycleEndpoints`:

```csharp
        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/merge",
            async (string owner, string repo, int number, HttpContext http,
                   IPrLifecycleWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
                   CancellationToken ct) =>
            {
                var prRef = new PrReference(owner, repo, number);

                if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before performing lifecycle actions.") is { } notSubscribed)
                    return notSubscribed;

                var tabId = http.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault();
                if (string.IsNullOrEmpty(tabId) || !PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(tabId))
                    return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

                MergeRequest? req;
                try { req = await http.Request.ReadFromJsonAsync<MergeRequest>(ct).ConfigureAwait(false); }
                catch (System.Text.Json.JsonException) { req = null; }

                // Mandatory head-SHA staleness guard (spec decision #4): never forward a merge with no sha.
                if (req is null || string.IsNullOrEmpty(req.HeadSha))
                    return Results.Json(new { code = "head-sha-required" }, statusCode: StatusCodes.Status400BadRequest);
                if (ParseMethod(req.Method) is not { } method)
                    return Results.Json(new { code = "invalid-merge-method" }, statusCode: StatusCodes.Status400BadRequest);

                var result = await writer.MergeAsync(prRef, method, req.HeadSha, ct).ConfigureAwait(false);
                if (result.Success)
                {
                    bus.Publish(new PrLifecycleChanged(prRef));
                    return Results.Ok();
                }
                var (code, status) = MapError(result.ErrorCode);
                return Results.Json(new { code }, statusCode: status);
            });
```

Extend `MapError` with the two merge codes (add before the `_` default):

```csharp
        PrLifecycleErrorCode.MergeNotMergeable     => ("merge-not-mergeable",     StatusCodes.Status422UnprocessableEntity),
        PrLifecycleErrorCode.MergeHeadChanged      => ("merge-head-changed",      StatusCodes.Status409Conflict),
```

Add `using System.Net.Http.Json;`? No — server reads via `http.Request.ReadFromJsonAsync` (built-in). Ensure `using Microsoft.AspNetCore.Http;` is present (it is, via the endpoint usings).

- [ ] **Step 4: Run happy-path test — verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "Merge_success_records_method_sha_and_publishes" -v minimal`
Expected: PASS.

- [ ] **Step 5: Write validation + error-map tests**

```csharp
[Theory]
[InlineData("{\"method\":\"squash\"}")]                       // headSha missing
[InlineData("{\"method\":\"squash\",\"headSha\":\"\"}")]      // headSha empty
public async Task Merge_missing_headSha_returns_400(string json)
{
    using var ctx = PrLifecycleEndpointsTestContext.Create();
    await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
    using var client = ctx.CreateClient();
    var req = new HttpRequestMessage(HttpMethod.Post, "/api/pr/o/r/1/merge")
    { Headers = { { "X-PRism-Tab-Id", "tab-123" } }, Content = new StringContent(json, System.Text.Encoding.UTF8, "application/json") };

    var resp = await client.SendAsync(req);

    resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    ctx.Writer.Calls.Should().BeEmpty();
}

[Theory]
[InlineData("Merge")]   // wrong case — the permissive enum trap
[InlineData("1")]        // numeric string
[InlineData("rocket")]   // unknown
public async Task Merge_invalid_method_returns_400(string method)
{
    using var ctx = PrLifecycleEndpointsTestContext.Create();
    await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
    using var client = ctx.CreateClient();

    var resp = await client.SendAsync(PostMerge(new { method, headSha = "abc" }));

    resp.StatusCode.Should().Be(HttpStatusCode.BadRequest);
    ctx.Writer.Calls.Should().BeEmpty();
}

[Theory]
[InlineData(PrLifecycleErrorCode.MergeNotMergeable, HttpStatusCode.UnprocessableEntity, "merge-not-mergeable")]
[InlineData(PrLifecycleErrorCode.MergeHeadChanged, HttpStatusCode.Conflict, "merge-head-changed")]
public async Task Merge_error_maps_to_status_and_code(PrLifecycleErrorCode err, HttpStatusCode status, string code)
{
    using var ctx = PrLifecycleEndpointsTestContext.Create();
    await ctx.SeedSessionAsync("o", "r", 1, PrLifecycleEndpointsTestContext.ValidSession());
    ctx.Writer.NextResult = PrLifecycleResult.Fail(err);
    using var client = ctx.CreateClient();

    var resp = await client.SendAsync(PostMerge(new { method = "merge", headSha = "abc" }));

    resp.StatusCode.Should().Be(status);
    (await resp.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("code").GetString().Should().Be(code);
    ctx.Bus.Published.OfType<PrLifecycleChanged>().Should().BeEmpty();
}
```

- [ ] **Step 6: Run all endpoint tests — verify pass**

Run: `dotnet test tests/PRism.Web.Tests --filter "FullyQualifiedName~PrLifecycleEndpointsTests" -v minimal`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Endpoints/PrLifecycleEndpoints.cs tests/PRism.Web.Tests/Endpoints/PrLifecycleEndpointsTests.cs
git commit -m "feat(#566): /merge endpoint — body DTO, headSha-required + method allowlist 400, error map"
```

---

## Task 4: Repo-allowed merge methods — GraphQL query + parse + serialization

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (`PrDetailGraphQLQuery` + parse in `GetPrDetailAsync`)
- Modify: the GraphQL byte-identity pin test (grep `PrDetailGraphQLQuery` in `tests/`)
- Test: the existing `GetPrDetailAsync`/`ParsePr` test (grep for it) — assert allowed-methods parse + default

**Interfaces:**
- Consumes: `TryGetPath(doc.RootElement, out var el, "data", "repository", "<field>")`.
- Produces: `Pr.AllowedMergeMethods` populated from `data.repository.{mergeCommitAllowed,squashMergeAllowed,rebaseMergeAllowed}`; absent → `new(true, true, true)`.

- [ ] **Step 1: Locate the byte-identity pin and the PR-detail parse test**

Run: `Grep pattern "PrDetailGraphQLQuery" path tests output_mode files_with_matches`
Run: `Grep pattern "GetPrDetailAsync|ParsePr|mergeStateStatus" path tests/PRism.GitHub.Tests output_mode files_with_matches`
Note the file(s); you'll update the pinned query string and add a parse assertion.

- [ ] **Step 2: Write the failing parse test (allowed-methods + default)**

In the located PR-detail parse test file, add (mirror the existing fixture-builder style; the GraphQL JSON must include the three fields on `repository`):

```csharp
[Fact]
public async Task GetPrDetailAsync_parses_allowed_merge_methods_from_repository()
{
    // Arrange a GraphQL response whose data.repository carries the three allowed-method flags.
    // (Use the file's existing response-builder helper; set mergeCommitAllowed=false,
    //  squashMergeAllowed=true, rebaseMergeAllowed=false on the repository node.)
    var dto = await /* existing harness */ .GetPrDetailAsync(Reference, CancellationToken.None);
    dto!.Pr.AllowedMergeMethods.Should().Be(new AllowedMergeMethods(false, true, false));
}

[Fact]
public async Task GetPrDetailAsync_defaults_allowed_methods_to_all_when_absent()
{
    // Response WITHOUT the three fields (older shape).
    var dto = await /* existing harness */ .GetPrDetailAsync(Reference, CancellationToken.None);
    dto!.Pr.AllowedMergeMethods.Should().Be(new AllowedMergeMethods(true, true, true));
}
```

> Implementer note: match the file's actual fixture mechanism (raw JSON string vs builder). The two assertions — explicit flags parsed, and all-true default when absent — are the contract.

- [ ] **Step 3: Run — verify fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "allowed_merge_methods OR allowed_methods_to_all" -v minimal`
Expected: FAIL (`AllowedMergeMethods` is null; query lacks the fields).

- [ ] **Step 4: Add the three fields to `PrDetailGraphQLQuery`**

In `GitHubReviewService.cs`, insert the fields on the `repository(...)` node, immediately after `repository(owner:$owner,name:$repo){` and before `pullRequest`:

```csharp
    internal const string PrDetailGraphQLQuery = "query($owner:String!,$repo:String!,$number:Int!){" +
        "viewer{login} " +
        "repository(owner:$owner,name:$repo){" +
        "mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed " +
        "pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus reviewDecision updatedAt " +
        // … rest unchanged …
```

- [ ] **Step 5: Parse the fields at the call site and thread into `Pr`**

In `GetPrDetailAsync`, after `var pr = GitHubPrParser.ParsePr(pull, reference);`, resolve the repo-level flags from the root (mirroring the `viewer` sibling pattern) and attach via `pr with`:

```csharp
        // Repo-allowed merge methods are on data.repository (sibling of pullRequest), not reachable
        // from `pull`. Resolve from the root like viewer.login; absent fields default all-true.
        static bool Flag(JsonElement root, string field) =>
            TryGetPath(root, out var el, "data", "repository", field)
            && el.ValueKind == JsonValueKind.True;
        var hasAny = TryGetPath(doc.RootElement, out _, "data", "repository", "mergeCommitAllowed");
        var allowed = hasAny
            ? new AllowedMergeMethods(
                Flag(doc.RootElement, "mergeCommitAllowed"),
                Flag(doc.RootElement, "squashMergeAllowed"),
                Flag(doc.RootElement, "rebaseMergeAllowed"))
            : new AllowedMergeMethods(true, true, true);
        pr = pr with { AllowedMergeMethods = allowed };
```

(If `pr` is declared with `var` and immutable, change to `var pr = … ; pr = pr with { … };` — `Pr` is a record so `with` works.)

- [ ] **Step 6: Update the GraphQL byte-identity pin**

In the pin test located in Step 1, update the expected query string to include `mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed ` on the repository node (byte-exact). This is an intentional query change.

- [ ] **Step 7: Run the parse + pin tests — verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "allowed OR ByteIdentity OR GraphQl" -v minimal`
Expected: PASS.

- [ ] **Step 8: Confirm `AllowedMergeMethods` serializes camelCase to the wire**

Run: `Grep pattern "PrDetailDto|JsonSerializerOptions|CamelCase|PropertyNamingPolicy" path PRism.Web output_mode files_with_matches`
Verify the PR detail response uses camelCase (so `Pr.AllowedMergeMethods` → `allowedMergeMethods: { merge, squash, rebase }`). If there is an explicit response-DTO mapping (not direct `Pr` serialization), add the field there. Note the finding for FE Task 6's wire shape.

- [ ] **Step 9: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/
git commit -m "feat(#566): fetch + parse repo-allowed merge methods into Pr.AllowedMergeMethods"
```

---

## Task 5: Frontend API — `mergePr` + error codes + `allowedMergeMethods` type

**Files:**
- Modify: `frontend/src/api/prLifecycle.ts`
- Modify: `frontend/src/api/types.ts`
- Test: `frontend/src/api/prLifecycle.test.ts` (create if absent)

**Interfaces:**
- Produces: `type AllowedMergeMethods = { merge: boolean; squash: boolean; rebase: boolean }`; `PrDetailPr.allowedMergeMethods?: AllowedMergeMethods`; `PrLifecycleErrorCode` += `'merge-not-mergeable' | 'merge-head-changed'`; `mergePr(prRef, method: MergeMethodWire, headSha: string): Promise<PrActionResult>` where `MergeMethodWire = 'merge' | 'squash' | 'rebase'`, POSTing `{ method, headSha }`.

- [ ] **Step 1: Add the type to `types.ts`**

```ts
export type AllowedMergeMethods = { merge: boolean; squash: boolean; rebase: boolean };
```

In `PrDetailPr`, add:

```ts
  allowedMergeMethods?: AllowedMergeMethods;
```

- [ ] **Step 2: Write the failing `mergePr` test**

Create `frontend/src/api/prLifecycle.test.ts` (or extend it) — mock `apiClient.post`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mergePr } from './prLifecycle';
import { apiClient, ApiError } from './client';

vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return { ...actual, apiClient: { post: vi.fn() } };
});

const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('mergePr', () => {
  beforeEach(() => vi.clearAllMocks());

  it('POSTs /merge with method + headSha and returns ok', async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const res = await mergePr(prRef, 'squash', 'abc123');
    expect(apiClient.post).toHaveBeenCalledWith('/api/pr/o/r/1/merge', { method: 'squash', headSha: 'abc123' });
    expect(res).toEqual({ ok: true });
  });

  it('maps merge-head-changed body code', async () => {
    (apiClient.post as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(409, 'req', { code: 'merge-head-changed' }),
    );
    const res = await mergePr(prRef, 'merge', 'abc');
    expect(res).toEqual({ ok: false, code: 'merge-head-changed' });
  });
});
```

> Implementer note: confirm `ApiError`'s constructor signature in `client.ts` and adjust the `new ApiError(...)` args to match.

- [ ] **Step 3: Run — verify fail**

Run: `frontend/node_modules/.bin/vitest run src/api/prLifecycle.test.ts`
Expected: FAIL (`mergePr` not exported).

- [ ] **Step 4: Extend `prLifecycle.ts`**

Add the two codes to the union and the `KNOWN` set, a `MergeMethodWire` type, and `mergePr` (it sends a body, so it can't use the bodyless `run`):

```ts
export type PrLifecycleErrorCode =
  | 'token-cannot-write'
  | 'repo-rule-blocked'
  | 'reopen-not-possible'
  | 'plan-unsupported-drafts'
  | 'rate-limited'
  | 'merge-not-mergeable'
  | 'merge-head-changed'
  | 'subscribe-rejected'
  | 'generic';

export type MergeMethodWire = 'merge' | 'squash' | 'rebase';
```

Add both new codes to the `KNOWN` set:

```ts
const KNOWN: ReadonlySet<string> = new Set([
  'token-cannot-write',
  'repo-rule-blocked',
  'reopen-not-possible',
  'plan-unsupported-drafts',
  'rate-limited',
  'merge-not-mergeable',
  'merge-head-changed',
]);
```

Add `mergePr` (after the four `run`-based exports):

```ts
export async function mergePr(
  prRef: PrReference,
  method: MergeMethodWire,
  headSha: string,
): Promise<PrActionResult> {
  try {
    await apiClient.post(`${prPath(prRef)}/merge`, { method, headSha });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const raw = (e.body as { code?: string } | null | undefined)?.code;
      if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
      const code = raw && KNOWN.has(raw) ? (raw as PrLifecycleErrorCode) : 'generic';
      return { ok: false, code };
    }
    return { ok: false, code: 'generic' };
  }
}
```

> Implementer note: confirm `apiClient.post` accepts a second `body` arg (the four existing calls pass none). If the signature differs, adapt to how `client.ts` sends a JSON body.

- [ ] **Step 5: Run — verify pass + typecheck**

Run: `frontend/node_modules/.bin/vitest run src/api/prLifecycle.test.ts`
Expected: PASS.
Run: `cd frontend && npx tsc -b`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/api/prLifecycle.ts frontend/src/api/types.ts frontend/src/api/prLifecycle.test.ts
git commit -m "feat(#566): FE mergePr client + merge error codes + allowedMergeMethods type"
```

---

## Task 6: `usePrAction` — merge kind, reconcile window, error reconcile, phases

**Files:**
- Modify: `frontend/src/hooks/usePrAction.ts`
- Test: `frontend/src/hooks/usePrAction.test.ts`

**Interfaces:**
- Consumes: `mergePr`, `MergeMethodWire` (Task 5); `useToast().show`.
- Produces: `PrActionKind` += `'merge'`; `PrLifecycleState` += `isMerged: boolean`; `MergePhase = 'idle' | 'merging' | 'checking'`; `invoke(kind, payload?: { method: MergeMethodWire; headSha: string })`; result += `mergePhase: MergePhase`. Merge reconcile uses `MERGE_RECONCILE_MS = 10_000`; success holds `pending='merge'` until `isMerged`; `merge-head-changed` → `reload()` + collapse + stale-sha gate; `merge-not-mergeable` → `'checking'` + reload + isMerged re-check (success-if-merged) else toast; fallback → still-finishing info toast.

> **Structure note (plan decision):** the spec said "extend usePrAction." Merge's branch is materially heavier than the four state flips; it is kept in `usePrAction` per the spec but isolated in a clearly-commented merge section. If the file becomes unwieldy during review, splitting a `useMergeAction` hook is an acceptable follow-up — the public surface (`invoke('merge', …)`, `mergePhase`) stays the same.

- [ ] **Step 1: Write the failing test — merge success holds then releases on isMerged**

Add to `usePrAction.test.ts` (mirror existing fake-timer + `renderHook` patterns; mock `../api/prLifecycle`):

```ts
it('merge: holds pending through reconcile, releases when isMerged flips', async () => {
  vi.useFakeTimers();
  mergePrMock.mockResolvedValue({ ok: true });
  let state = { isClosed: false, isDraft: false, isMerged: false };
  const reload = vi.fn();
  const { result, rerender } = renderHook(
    (s) => usePrAction({ prRef, reload, prState: s }),
    { initialProps: state },
  );

  act(() => result.current.invoke('merge', { method: 'squash', headSha: 'abc' }));
  await act(async () => { await Promise.resolve(); });
  expect(result.current.pending).toBe('merge');        // held through reconcile

  state = { ...state, isMerged: true };
  rerender(state);                                      // SSE reload observed isMerged
  expect(result.current.pending).toBeNull();           // released on target
});
```

- [ ] **Step 2: Run — verify fail**

Run: `frontend/node_modules/.bin/vitest run src/hooks/usePrAction.test.ts -t "holds pending through reconcile"`
Expected: FAIL (`'merge'` not a kind; `isMerged` not in state).

- [ ] **Step 3: Extend the hook — types, target, reconcile window, merge branch**

Apply these edits to `usePrAction.ts`:

(a) imports + types:

```ts
import { closePr, reopenPr, markReady, convertToDraft, mergePr, type PrLifecycleErrorCode, type MergeMethodWire } from '../api/prLifecycle';

export type PrActionKind = 'close' | 'reopen' | 'ready' | 'convert-to-draft' | 'merge';
export type MergePhase = 'idle' | 'merging' | 'checking';
export interface PrLifecycleState { isClosed: boolean; isDraft: boolean; isMerged: boolean; }
export interface MergePayload { method: MergeMethodWire; headSha: string; }
export interface UsePrActionResult {
  pending: PrActionKind | null;
  mergePhase: MergePhase;
  invoke: (kind: PrActionKind, payload?: MergePayload) => void;
}

const FALLBACK_MS = 5000;
const MERGE_RECONCILE_MS = 10_000; // commit-creation + GraphQL read-after-write; one window for all merge paths
```

(b) `reachedTarget` gains merge:

```ts
function reachedTarget(kind: PrActionKind, s: PrLifecycleState): boolean {
  switch (kind) {
    case 'close': return s.isClosed;
    case 'reopen': return !s.isClosed;
    case 'ready': return !s.isClosed && !s.isDraft;
    case 'convert-to-draft': return !s.isClosed && s.isDraft;
    case 'merge': return s.isMerged;
  }
}
```

(c) `copyFor` gains the two merge codes:

```ts
    case 'merge-head-changed':
      return 'The PR changed since you loaded it — re-arm to retry with the latest.';
    case 'merge-not-mergeable':
      return "This PR can't be merged right now (checks, protection, or method changed).";
```

(d) new state + a stale-sha ref + a timeout-outcome ref:

```ts
  const [mergePhase, setMergePhase] = useState<MergePhase>('idle');
  const staleHeadShaRef = useRef<string | null>(null);      // a headSha that 409'd; block re-merge until it changes
  const mergeTimeoutKindRef = useRef<'reload-silent' | 'toast-not-mergeable' | null>(null);
```

(e) in the reconcile effect, when the pending action reaches target, also reset merge state:

```ts
      setPending(null);
      inFlight.current = false;
      setMergePhase('idle');
      mergeTimeoutKindRef.current = null;
```

(f) replace `invoke` to branch on merge. Non-merge keeps the existing `ACTIONS` path; merge gets its own:

```ts
  const invoke = useCallback(
    (kind: PrActionKind, payload?: MergePayload) => {
      if (inFlight.current) return;
      if (kind === 'merge') { invokeMerge(payload); return; }
      // ── existing non-merge path (unchanged) ──
      inFlight.current = true;
      setPending(kind);
      void ACTIONS[kind as Exclude<PrActionKind, 'merge'>](prRef)
        .then((r) => { /* … existing body verbatim … */ })
        .catch(() => { /* … existing … */ });
    },
    [prRef, reload, show, clearTimer],
  );
```

(g) add `invokeMerge` (the merge-specific orchestration). Define it as a `useCallback` above `invoke`:

```ts
  // Arm a reconcile hold for merge: keep pending='merge' until isMerged is observed, bounded by
  // MERGE_RECONCILE_MS. onTimeout decides what the bound does: 'reload-silent' (happy fallback —
  // reload + show the still-finishing snackbar) or 'toast-not-mergeable' (405/422 reconcile lost).
  const armMergeHold = useCallback((onTimeout: 'reload-silent' | 'toast-not-mergeable') => {
    pendingKindRef.current = 'merge';
    mergeTimeoutKindRef.current = onTimeout;
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      pendingKindRef.current = null;
      const outcome = mergeTimeoutKindRef.current;
      mergeTimeoutKindRef.current = null;
      setPending(null);
      setMergePhase('idle');
      inFlight.current = false;
      if (outcome === 'toast-not-mergeable') {
        show({ kind: 'error', message: copyFor('merge-not-mergeable') });
      } else {
        reload();
        show({ kind: 'info', message: 'The merge may still be processing — refresh if the status doesn’t update.' });
      }
    }, MERGE_RECONCILE_MS);
  }, [clearTimer, reload, show]);

  const invokeMerge = useCallback((payload?: MergePayload) => {
    if (!payload) return;
    // Stale-sha gate: after a 409, refuse to re-merge the same headSha until a reload changed it.
    if (staleHeadShaRef.current && staleHeadShaRef.current === payload.headSha) {
      show({ kind: 'error', message: 'Could not refresh the PR — try again.' });
      return;
    }
    inFlight.current = true;
    setPending('merge');
    setMergePhase('merging');
    void mergePr(prRef, payload.method, payload.headSha)
      .then((r) => {
        if (r.ok) {
          staleHeadShaRef.current = null;
          if (latestState.current && reachedTarget('merge', latestState.current)) {
            setPending(null); setMergePhase('idle'); inFlight.current = false; return;
          }
          armMergeHold('reload-silent'); // hold; fallback reloads + still-finishing snackbar
          return;
        }
        if (r.code === 'merge-head-changed') {
          staleHeadShaRef.current = payload.headSha; // block re-merge until headSha changes
          setPending(null); setMergePhase('idle'); inFlight.current = false;
          reload();
          show({ kind: 'error', message: copyFor('merge-head-changed') });
          return;
        }
        if (r.code === 'merge-not-mergeable') {
          setMergePhase('checking');      // neutral "Checking…" while we reload + re-check isMerged
          reload();
          if (latestState.current && reachedTarget('merge', latestState.current)) {
            setPending(null); setMergePhase('idle'); inFlight.current = false; return; // already merged
          }
          armMergeHold('toast-not-mergeable'); // success if isMerged flips; else toast on timeout
          return;
        }
        // other codes: immediate release + toast
        setPending(null); setMergePhase('idle'); inFlight.current = false;
        show({ kind: 'error', message: copyFor(r.code) });
      })
      .catch(() => {
        setPending(null); setMergePhase('idle'); inFlight.current = false;
        show({ kind: 'error', message: copyFor(undefined) });
      });
  }, [prRef, reload, show, armMergeHold]);
```

(h) return `mergePhase`:

```ts
  return { pending, mergePhase, invoke };
```

> Implementer note: confirm `useToast().show` accepts `kind: 'info'`. If the Toast API has no info kind, use the existing neutral kind (grep `Toast/useToast`). Keep `latestState.current` mirroring `prState` every render (existing line) — the merge re-checks depend on it.

- [ ] **Step 4: Run the success-hold test — verify pass**

Run: `frontend/node_modules/.bin/vitest run src/hooks/usePrAction.test.ts -t "holds pending through reconcile"`
Expected: PASS.

- [ ] **Step 5: Write the error-reconcile tests**

```ts
it('merge-head-changed: reloads, releases, and blocks re-merge on the same headSha', async () => {
  mergePrMock.mockResolvedValue({ ok: false, code: 'merge-head-changed' });
  const reload = vi.fn();
  const { result } = renderHook(() => usePrAction({ prRef, reload, prState: { isClosed: false, isDraft: false, isMerged: false } }));
  await act(async () => { result.current.invoke('merge', { method: 'merge', headSha: 'old' }); await Promise.resolve(); });
  expect(reload).toHaveBeenCalled();
  expect(result.current.pending).toBeNull();
  // re-merge with the SAME headSha is blocked (stale-sha gate)
  await act(async () => { result.current.invoke('merge', { method: 'merge', headSha: 'old' }); await Promise.resolve(); });
  expect(mergePrMock).toHaveBeenCalledTimes(1); // second invoke short-circuited
});

it('merge-not-mergeable: reconciles to success when isMerged flips during checking', async () => {
  vi.useFakeTimers();
  mergePrMock.mockResolvedValue({ ok: false, code: 'merge-not-mergeable' });
  let state = { isClosed: false, isDraft: false, isMerged: false };
  const { result, rerender } = renderHook((s) => usePrAction({ prRef, reload: vi.fn(), prState: s }), { initialProps: state });
  await act(async () => { result.current.invoke('merge', { method: 'merge', headSha: 'abc' }); await Promise.resolve(); });
  expect(result.current.mergePhase).toBe('checking');
  state = { ...state, isMerged: true };
  rerender(state);                                  // reload observed the merge actually landed
  expect(result.current.pending).toBeNull();        // reconciled to success, no error toast
  expect(toastShow).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
});
```

> Implementer note: wire `mergePrMock`/`toastShow` to your existing module mocks at the top of the test file (mirror how the close/reopen tests mock `../api/prLifecycle` and `../components/Toast/useToast`). Add `isMerged: false` to every existing `prState` literal in this file (the type now requires it).

- [ ] **Step 6: Run the full hook suite — verify pass**

Run: `frontend/node_modules/.bin/vitest run src/hooks/usePrAction.test.ts`
Expected: PASS (new + existing, after adding `isMerged` to existing state literals).

- [ ] **Step 7: Commit**

```bash
git add frontend/src/hooks/usePrAction.ts frontend/src/hooks/usePrAction.test.ts
git commit -m "feat(#566): usePrAction merge — reconcile window, head-changed gate, not-mergeable success reconcile"
```

---

## Task 7: `MergeMethodPicker` component

**Files:**
- Create: `frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.tsx`
- Create: `frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.test.tsx`

**Interfaces:**
- Consumes: `AllowedMergeMethods`, `MergeMethodWire`.
- Produces: `MergeMethodPicker({ allowed, value, onChange, disabled, onEscape })` rendering a `role="radiogroup"` of allowed methods. **Renders nothing when ≤1 method is allowed** (the single method is conveyed by the parent's Confirm button label). Export `allowedList(allowed): MergeMethodWire[]` (order merge→squash→rebase) and `firstAllowed(allowed): MergeMethodWire`.

- [ ] **Step 1: Write failing tests**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MergeMethodPicker, allowedList, firstAllowed } from './MergeMethodPicker';

describe('allowedList / firstAllowed', () => {
  it('orders merge→squash→rebase and picks first allowed', () => {
    expect(allowedList({ merge: false, squash: true, rebase: true })).toEqual(['squash', 'rebase']);
    expect(firstAllowed({ merge: false, squash: true, rebase: true })).toBe('squash');
  });
  it('defaults to all three when none flagged', () => {
    expect(allowedList({ merge: false, squash: false, rebase: false })).toEqual(['merge', 'squash', 'rebase']);
  });
});

describe('MergeMethodPicker', () => {
  it('renders a radiogroup of allowed methods only', () => {
    render(<MergeMethodPicker allowed={{ merge: true, squash: true, rebase: false }} value="merge" onChange={() => {}} />);
    expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(2);
  });

  it('renders nothing when only one method is allowed', () => {
    const { container } = render(<MergeMethodPicker allowed={{ merge: false, squash: true, rebase: false }} value="squash" onChange={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('arrow key changes selection', async () => {
    const onChange = vi.fn();
    render(<MergeMethodPicker allowed={{ merge: true, squash: true, rebase: true }} value="merge" onChange={onChange} />);
    const radios = screen.getAllByRole('radio');
    radios[0].focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(onChange).toHaveBeenCalledWith('squash');
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `frontend/node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/MergeMethodPicker.test.tsx`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement the component**

```tsx
// frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.tsx
import type { AllowedMergeMethods, MergeMethodWire } from '../../../api/types';
import styles from './PrActionsPanel.module.css';

const ORDER: MergeMethodWire[] = ['merge', 'squash', 'rebase'];
const LABEL: Record<MergeMethodWire, string> = { merge: 'Merge commit', squash: 'Squash', rebase: 'Rebase' };

export function allowedList(a: AllowedMergeMethods): MergeMethodWire[] {
  const list = ORDER.filter((m) => a[m]);
  return list.length > 0 ? list : [...ORDER]; // none flagged → offer all (server is authority via 405)
}
export function firstAllowed(a: AllowedMergeMethods): MergeMethodWire {
  return allowedList(a)[0];
}

interface Props {
  allowed: AllowedMergeMethods;
  value: MergeMethodWire;
  onChange: (m: MergeMethodWire) => void;
  disabled?: boolean;
  onEscape?: () => void;
}

export function MergeMethodPicker({ allowed, value, onChange, disabled, onEscape }: Props) {
  const list = allowedList(allowed);
  if (list.length <= 1) return null; // single method → conveyed by the Confirm button label

  const move = (dir: 1 | -1) => {
    const i = list.indexOf(value);
    const next = list[(i + dir + list.length) % list.length];
    onChange(next);
  };

  return (
    <div
      role="radiogroup"
      aria-label="Merge method"
      className={styles.methodPicker}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); onEscape?.(); return; }
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      }}
    >
      {list.map((m) => {
        const selected = m === value;
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}   // roving tabindex
            disabled={disabled}
            className={`${styles.methodOption} ${selected ? styles.methodOptionSelected : ''}`}
            onClick={() => onChange(m)}
          >
            {LABEL[m]}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run — verify pass**

Run: `frontend/node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/MergeMethodPicker.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.tsx frontend/src/components/PrDetail/OverviewTab/MergeMethodPicker.test.tsx
git commit -m "feat(#566): MergeMethodPicker radiogroup (single-method suppressed, arrow nav, roving tabindex)"
```

---

## Task 8: `PrActionsPanel` — merge affordance, gating, disabled-reason, focus/a11y

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx`
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.module.css`
- Test: locate via `Glob frontend/src/**/PrActionsPanel.test.tsx`

**Interfaces:**
- Consumes: `usePrAction` (now `mergePhase`, merge `invoke`), `MergeMethodPicker`/`firstAllowed`, `mergeReadiness` copy (`READINESS_LONG`/`READINESS_TOOLTIP`), `usePrDetailContext` (`prDetail.pr.allowedMergeMethods`, `mergeReadiness`, `headSha`, `isMerged`, `reload`).
- Produces: a Merge affordance with: `showMerge = !isClosed && !isMerged && !isDraft`; enable per Option X; disabled-reason node + `aria-describedby`; `none` Refresh link; armed morph → picker + method-named Confirm button; `unstable` note linked via `aria-describedby`; selected method persisted in panel state; merge-in-flight + checking labels.

> Build this incrementally. Each step adds one behavior with its test.

- [ ] **Step 1: Pass `isMerged` into `usePrAction` and add the gating helpers (test-first)**

Write a failing test asserting the Merge button is enabled for `ready` and disabled-with-reason for `conflicts`:

```tsx
it('shows Merge enabled when ready, disabled-with-reason on conflicts', () => {
  renderPanel({ isClosed: false, isMerged: false, isDraft: false, mergeReadiness: 'ready', allowedMergeMethods: { merge: true, squash: true, rebase: false } });
  expect(screen.getByRole('button', { name: /^merge$/i })).toBeEnabled();

  renderPanel({ mergeReadiness: 'conflicts' });
  const btn = screen.getByRole('button', { name: /^merge$/i });
  expect(btn).toBeDisabled();
  expect(btn).toHaveAccessibleDescription(/conflict/i);
});
```

> Implementer note: reuse the file's existing `renderPanel`/context-provider helper; extend its default `pr` fixture with `mergeReadiness`, `isMerged`, `allowedMergeMethods`, `headSha`.

- [ ] **Step 2: Run — verify fail**, then implement the gating + button + disabled-reason.

In `PrActionsPanel.tsx`:

(a) update the `usePrAction` state arg to include `isMerged`:

```tsx
    prState: pr ? { isClosed: pr.isClosed, isDraft: pr.isDraft, isMerged: pr.isMerged } : undefined,
```

(b) destructure `mergePhase`:

```tsx
  const { pending, mergePhase, invoke } = usePrAction({ /* … */ });
```

(c) add gating constants near the other `show*`:

```tsx
  const showMerge = !!pr && !pr.isClosed && !pr.isMerged && !pr.isDraft;
  const MERGE_ENABLED: ReadonlySet<string> = new Set(['ready', 'ready-with-changes-requested', 'unstable']);
  const readiness = pr?.mergeReadiness ?? 'none';
  const mergeEnabled = showMerge && MERGE_ENABLED.has(readiness);
```

(d) compute the disabled-reason text (use `READINESS_LONG`; `none` has empty copy → supply the calculating string):

```tsx
  const mergeReason =
    readiness === 'none'
      ? 'Mergeability is still being calculated.'
      : READINESS_LONG[readiness as MergeReadiness] || '';
```

Import `READINESS_LONG` and `MergeReadiness` from `../../shared/mergeReadiness`.

- [ ] **Step 3: Render the Merge button + disabled-reason (test from Step 1 passes)**

Add into the `actions` cluster (after `showClose` block). The Confirm-button label always names the method; the in-flight label switches on `pending`/`mergePhase`.

```tsx
          {showMerge && !confirmingMerge && (
            <div className={styles.mergeWrap}>
              <button
                className={`btn ${styles.merge}`}
                disabled={siblingsDisabled || !mergeEnabled}
                aria-describedby={!mergeEnabled ? 'merge-reason' : undefined}
                onClick={() => setConfirmingMerge(true)}
              >
                <PrStateGlyph state="merged" />
                Merge
              </button>
              {!mergeEnabled && (
                <span id="merge-reason" className={styles.mergeReason}>
                  {mergeReason}{' '}
                  {readiness === 'none' && (
                    <button type="button" className={styles.refreshLink} onClick={() => reload()}>
                      Refresh
                    </button>
                  )}
                </span>
              )}
            </div>
          )}
```

> `PrStateGlyph state="merged"` — confirm the glyph supports a `merged` state; if not, use the nearest existing state and note a follow-up. `confirmingMerge` state + `selectedMethod` state are added in Step 4.

- [ ] **Step 4: Add the armed morph (test-first): picker + method-named Confirm**

Failing test:

```tsx
it('arming reveals the picker and a method-named Confirm; confirm calls invoke(merge)', async () => {
  const user = userEvent.setup();
  renderPanel({ mergeReadiness: 'ready', headSha: 'abc', allowedMergeMethods: { merge: true, squash: true, rebase: false } });
  await user.click(screen.getByRole('button', { name: /^merge$/i }));
  expect(screen.getByRole('radiogroup', { name: /merge method/i })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: /confirm merge commit/i }));
  expect(invokeSpy).toHaveBeenCalledWith('merge', { method: 'merge', headSha: 'abc' });
});
```

Implement the state + morph. Add near the other `useState`:

```tsx
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<MergeMethodWire | null>(null);
  const allowed = pr?.allowedMergeMethods ?? { merge: true, squash: true, rebase: true };
  const method = selectedMethod ?? firstAllowed(allowed); // persisted choice survives an armed collapse
```

Confirm-label helper:

```tsx
  const CONFIRM_LABEL: Record<MergeMethodWire, string> = {
    merge: 'Confirm merge commit',
    squash: 'Confirm squash merge',
    rebase: 'Confirm rebase merge',
  };
```

The armed block (rendered when `showMerge && confirmingMerge`):

```tsx
          {showMerge && confirmingMerge && (
            <span
              className={styles.confirm}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); setConfirmingMerge(false); } }}
            >
              <MergeMethodPicker
                allowed={allowed}
                value={method}
                onChange={setSelectedMethod}
                disabled={busy}
                onEscape={() => setConfirmingMerge(false)}
              />
              {readiness === 'unstable' && (
                <span id="merge-unstable-note" className={styles.unstableNote}>Non-required checks are failing</span>
              )}
              <button
                className="btn btn-danger"
                disabled={busy}
                aria-describedby={readiness === 'unstable' ? 'merge-unstable-note' : undefined}
                onClick={() => { onInvoke('merge', { method, headSha: pr!.headSha }); setConfirmingMerge(false); }}
              >
                {mergePhase === 'checking' ? 'Checking…' : pending === 'merge' ? 'Merging…' : CONFIRM_LABEL[method]}
              </button>
            </span>
          )}
```

Update `onInvoke` to forward the payload:

```tsx
  const onInvoke = (kind: PrActionKind, payload?: { method: MergeMethodWire; headSha: string }) => {
    containerRef.current?.focus();
    invoke(kind, payload);
  };
```

Import `MergeMethodPicker`, `firstAllowed`, and `MergeMethodWire`. Add `confirmingMerge` to the `siblingsDisabled` cross-suppression (so arming merge disables the other actions, mirroring `confirmingClose`):

```tsx
  const siblingsDisabled = busy || confirmingClose || confirmingMerge;
```

Also clear an open merge-confirm when the PR leaves the mergeable set (mirror the close effect):

```tsx
  useEffect(() => {
    if (confirmingMerge && (pr?.isClosed || pr?.isMerged || pr?.isDraft)) setConfirmingMerge(false);
  }, [pr?.isClosed, pr?.isMerged, pr?.isDraft, confirmingMerge]);
```

- [ ] **Step 5: Run the panel tests — verify the new ones pass**

Run: `frontend/node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx`
Expected: PASS for the new tests; fix any existing test that broke from the `siblingsDisabled`/state additions.

- [ ] **Step 6: Add the CSS**

In `PrActionsPanel.module.css`, add `.merge`, `.mergeWrap`, `.mergeReason`, `.refreshLink`, `.methodPicker`, `.methodOption`, `.methodOptionSelected`, `.unstableNote` — following the existing `.close`/`.reopen` token usage (target-state colour for merge = the `merged` glyph tone; reuse the design-system button tokens, no hardcoded hex). Verify both themes in B1.

- [ ] **Step 7: Lint + typecheck + commit**

Run: `cd frontend && npx tsc -b && npm run lint`
Expected: clean.

```bash
git add frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.module.css frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx
git commit -m "feat(#566): PrActionsPanel merge affordance — gating, disabled-reason, picker morph, method-named confirm"
```

---

## Task 9: Merge announcement + focus contract (§4a)

**Files:**
- Modify: `frontend/src/components/PrDetail/OverviewTab/PrActionsPanel.tsx`
- Test: `PrActionsPanel.test.tsx`

**Interfaces:**
- Produces: on any observed transition to `isMerged === true`, a "Pull request merged" announcement in a `polite` live region that survives the panel unmount, followed (next frame) by a focus move to a stable landmark; the `none`-Refresh focus rule.

> The panel currently unmounts on `pr.isMerged` (suppression guard). The "merged" announcement must therefore live in a region that is NOT inside the panel. Verify where a persistent live region exists (grep `aria-live` under `PrDetail`); reuse it, or host one in the PR-detail shell.

- [ ] **Step 1: Locate or add a persistent polite live region**

Run: `Grep pattern "aria-live" path frontend/src/components/PrDetail output_mode content -n true`
If a shell-level polite region exists, use its setter. Otherwise add one to the PR-detail container component (outside `PrActionsPanel`) exposing a `announce(msg: string)` via context.

- [ ] **Step 2: Write the failing test (announcement fires when isMerged flips)**

```tsx
it('announces "Pull request merged" when the PR becomes merged', async () => {
  const { rerender } = renderPanel({ isMerged: false, mergeReadiness: 'ready' });
  rerender(panelWith({ isMerged: true }));
  expect(await screen.findByText(/pull request merged/i)).toBeInTheDocument();
});
```

- [ ] **Step 3: Implement the announce-then-focus effect**

In the PR-detail shell (or the panel's parent that persists), add:

```tsx
  const wasMergedRef = useRef(pr?.isMerged ?? false);
  useEffect(() => {
    if (pr?.isMerged && !wasMergedRef.current) {
      announce('Pull request merged');                       // (1) queue announcement first
      requestAnimationFrame(() => prTitleRef.current?.focus()); // (2) then move focus next frame
    }
    wasMergedRef.current = pr?.isMerged ?? false;
  }, [pr?.isMerged, announce]);
```

> `prTitleRef` is the PR title heading (give it `tabIndex={-1}` if not focusable). This effect lives where it survives the panel unmount.

- [ ] **Step 4: Run — verify pass**

Run: `frontend/node_modules/.bin/vitest run src/components/PrDetail/OverviewTab/PrActionsPanel.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/
git commit -m "feat(#566): merge success announcement + focus contract (§4a)"
```

---

## Task 10: Full-suite gate + live validation (B1/B2)

- [ ] **Step 1: Backend full suite**

Run: `dotnet test PRism.sln -v minimal` (timeout ≥ 300000ms)
Expected: all green.

- [ ] **Step 2: Frontend full suite + lint + typecheck**

Run: `frontend/node_modules/.bin/vitest run`
Run: `cd frontend && npx tsc -b && npm run lint`
Expected: all green.

- [ ] **Step 3: Run `/simplify` over the diff** (quality pass before push), then re-run both suites.

- [ ] **Step 4: B1 (UI-visual, both themes)** — launch via `run.ps1 -Reset None --no-browser` (real PAT) and capture the panel states from the spec's B1 list: armed multi-method, armed single-method (method-named button, no picker), disabled-with-reason, `none` calculating+Refresh, `unstable` note, in-flight. Light + dark.

- [ ] **Step 5: B2 (irreversible live merge)** — against a mergeable `prpande/prism-sandbox` PR (#2 or #10): arm → pick method → Confirm → observe header reconcile to `merged` + panel suppression; verify the default commit title. Also verify `token-cannot-write` copy on an under-scoped PAT. A live merge consumes the PR — recreate a fixture (`gh pr create` on a trivial branch) if re-running.

- [ ] **Step 6: Pre-push checklist** (`.ai/docs/development-process.md`) verbatim, then push and open the PR with the `## Proof` section recording B1/B2 evidence and the ce-doc-review dispositions.

---

## Self-Review (completed during planning)

- **Spec coverage:** every §1–§4a item maps to a task — backend seam (T1–T2), endpoint+validation (T3), allowed-methods data (T4), FE client+types (T5), hook reconcile (T6), picker (T7), panel gating/morph/disabled-reason (T8), announcement/focus (T9), gates (T10). Known-limitations are documentation, not tasks.
- **Type consistency:** `MergeMethodWire` ('merge'|'squash'|'rebase') is the FE wire type; backend `MergeMethod` enum maps to the same strings via `WireMethod`/`ParseMethod`. `PrLifecycleState.isMerged`, `mergePhase`, and `invoke(kind, payload?)` are introduced in T6 and consumed in T8 with matching names. `AllowedMergeMethods` shape `{merge,squash,rebase}` is identical across `Pr.cs`, `types.ts`, and `MergeMethodPicker`.
- **Open implementer-verify points (flagged inline, not placeholders):** `apiClient.post` body-arg signature (T5); `useToast` `info` kind (T6); `PrStateGlyph` `merged` state (T8); persistent live-region host (T9); exact byte-identity pin file + PR-detail parse-test fixture mechanism (T4). Each has a concrete fallback noted at its step.
