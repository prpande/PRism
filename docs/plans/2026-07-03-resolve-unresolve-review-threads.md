# Resolve / Unresolve review-comment threads — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a reviewer resolve an active review-comment thread and unresolve (re-activate) a resolved one directly from the Files-tab diff, backed by GitHub's `resolveReviewThread`/`unresolveReviewThread` GraphQL mutations.

**Architecture:** Mirror the #566 write-path foundation. A sibling `IReviewThreadWriter` (Core interface, GitHub impl) issues the mutations; a new `PrReviewThreadEndpoints` exposes gated POST routes that bind `threadId` to the route's PR, then publish `ReviewThreadResolutionChanged` → `PrDetailLoader.Invalidate` + SSE fanout. The frontend adds a state-aware green-outline Resolve / neutral Unresolve control to the thread widget, driven by a per-thread `useThreadResolution` hook (confirm-then-apply: button spinner, hold until the reloaded snapshot reflects the target, no optimism).

**Tech Stack:** .NET 10 minimal APIs, System.Text.Json, GitHub GraphQL v4; React + Vite + TypeScript, vitest + Testing Library.

**Spec:** `docs/specs/2026-07-03-resolve-unresolve-review-threads-design.md` (spec gate PASSED; auth binding = BIND).

## Global Constraints

- **Wire enums are kebab-case** (single `JsonStringEnumConverter`); error `code`s are kebab strings.
- **GraphQL Node IDs are opaque** — `threadId` (`PRRT_…`) is passed through verbatim; no parsing/synthesis.
- **`using Octokit;` must not appear** in any `PRism.Core` / `PRism.Web` source file.
- **`GitHubGraphQL.PostAsync` throws `HttpRequestException` on any non-2xx**; only GraphQL field-errors arrive as HTTP 200 + `errors[]`. Every mutation call is wrapped (see Task 2).
- **Two 403 bodies** (`unauthorized` gate vs `token-cannot-write` writer) — the FE disambiguates on `code`, never HTTP status.
- **Test factories override `ConfigureWebHost`, not `CreateHostBuilder`** (.NET 10 minimal hosting base is null).
- **Frontend:** `prettier --write` new files; `eslint` ignores `_`-prefixed unused; typecheck with `tsc -b` (not `--noEmit`). Run vitest via the local binary, never `npx vitest`.
- **Naming (verbatim):** interface `IReviewThreadWriter`; result `ReviewThreadResult`; enum `ReviewThreadErrorCode { None, TokenCannotWrite, ThreadNotFound, RateLimited, Generic }`; event `ReviewThreadResolutionChanged(PrReference PrRef)`; wire event name `review-thread-resolution-changed`; endpoints `POST /api/pr/{owner}/{repo}/{number:int:min(1)}/thread/{resolve|unresolve}` with body `{ "threadId": "…" }`; FE api `resolveThread` / `unresolveThread`; hook `useThreadResolution`; subscriber `useReviewThreadResolutionChangedSubscriber`; CSS class `.btn-success-outline`.

---

## Task 1: Writer contract (`IReviewThreadWriter` + result types)

**Files:**
- Create: `PRism.Core/IReviewThreadWriter.cs`
- Test: `tests/PRism.Core.Tests/ReviewThreadResultTests.cs`

**Interfaces:**
- Produces: `IReviewThreadWriter.ResolveAsync(PrReference, string threadId, CancellationToken) : Task<ReviewThreadResult>`, `UnresolveAsync(…) : Task<ReviewThreadResult>`; `enum ReviewThreadErrorCode { None, TokenCannotWrite, ThreadNotFound, RateLimited, Generic }`; `record ReviewThreadResult(bool Success, ReviewThreadErrorCode ErrorCode)` with `Ok` / `Fail(code)`.

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core;
using Xunit;

public class ReviewThreadResultTests
{
    [Fact]
    public void Ok_is_success_with_none()
    {
        Assert.True(ReviewThreadResult.Ok.Success);
        Assert.Equal(ReviewThreadErrorCode.None, ReviewThreadResult.Ok.ErrorCode);
    }

    [Fact]
    public void Fail_carries_the_code_and_is_not_success()
    {
        var r = ReviewThreadResult.Fail(ReviewThreadErrorCode.TokenCannotWrite);
        Assert.False(r.Success);
        Assert.Equal(ReviewThreadErrorCode.TokenCannotWrite, r.ErrorCode);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests --filter ReviewThreadResultTests`
Expected: FAIL — `IReviewThreadWriter` / `ReviewThreadResult` do not exist (compile error).

- [ ] **Step 3: Write the interface + types** (mirror `PRism.Core/IPrLifecycleWriter.cs:12-55`)

```csharp
using PRism.Core.Contracts;

namespace PRism.Core;

// #571 — the GitHub review-thread resolution write surface. Sibling of IPrLifecycleWriter
// (kept separate per that interface's own header note). GraphQL-only: resolveReviewThread /
// unresolveReviewThread, keyed by the opaque thread node id. Methods take PrReference so the
// endpoint can bind the thread to its PR (spec §5.4) before the mutation.
public interface IReviewThreadWriter
{
    Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct);
    Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct);
}

public enum ReviewThreadErrorCode
{
    None,
    TokenCannotWrite, // scope/permission denial OR non-collaborator (GitHub uses one body)
    ThreadNotFound,   // "Could not resolve to a node" — stale/foreign thread id
    RateLimited,      // secondary/primary rate-limit — transient, never token-cannot-write
    Generic,          // anything else
}

public sealed record ReviewThreadResult(bool Success, ReviewThreadErrorCode ErrorCode)
{
    public static ReviewThreadResult Ok { get; } = new(true, ReviewThreadErrorCode.None);
    public static ReviewThreadResult Fail(ReviewThreadErrorCode code) => new(false, code);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests --filter ReviewThreadResultTests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/IReviewThreadWriter.cs tests/PRism.Core.Tests/ReviewThreadResultTests.cs
git commit -m "feat(#571): IReviewThreadWriter contract + result types"
```

---

## Task 2: GitHub writer (`GitHubReviewThreadWriter`) + DI

**Files:**
- Create: `PRism.GitHub/GitHubReviewThreadWriter.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (register `IReviewThreadWriter`, mirroring the `IPrLifecycleWriter` singleton at `:94-106`)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewThreadWriterTests.cs`

**Interfaces:**
- Consumes: `IReviewThreadWriter` (Task 1), `GitHubGraphQL.PostAsync`, `GitHubHttp.Truncate`.
- Produces: `internal sealed partial class GitHubReviewThreadWriter : IReviewThreadWriter`.

**Approach.** Mirror `GitHubPrLifecycleWriter.cs` verbatim for transport (`PostGraphQLAsync` wrapper, the `Func<Task<string?>> _readToken` + `_host` + `IHttpClientFactory` ctor, the `[LoggerMessage]` partial). The mutation takes `threadId` directly — **no `ResolveNodeIdAsync`** (unlike the lifecycle draft toggles). Classification reuses both channels: `try/catch (HttpRequestException) → ClassifyHttpStatus` for thrown non-2xx, and a `FirstGraphQLErrorCode`-style body match for HTTP-200 `errors[]`.

> **Live-validation gate (do this before pinning Step 3's substrings).** The permission-error wording for `resolveReviewThread`/`unresolveReviewThread` was NOT validated by #566 (which used `closePr`/`markReady`/`merge`). Per the repo rule "live-validate GitHub write-API premises against a REAL PR": with a read-only fine-grained token, invoke `resolveReviewThread` against a real PR thread and capture the actual GraphQL `errors[0].message`/`type`. Pin the substrings in `ClassifyThreadGraphQLError` to the observed value and seed the Step 1 test with the **captured** body. If the observed message differs from the assumed `"not have permission"` / `"Resource not accessible"`, use the observed one.

- [ ] **Step 1: Write the failing tests** (fake `HttpMessageHandler` returning canned GraphQL responses)

```csharp
using System.Net;
using PRism.Core;
using PRism.Core.Contracts;
using Xunit;

public class GitHubReviewThreadWriterTests
{
    static GitHubReviewThreadWriter Make(FakeHandler handler) =>
        new(new SingleClientFactory(handler), () => Task.FromResult<string?>("t"), "github.com",
            NullLogger<GitHubReviewThreadWriter>.Instance);

    [Fact]
    public async Task Resolve_success_returns_ok()
    {
        var h = FakeHandler.Json(HttpStatusCode.OK,
            """{"data":{"resolveReviewThread":{"thread":{"id":"PRRT_1","isResolved":true}}}}""");
        var r = await Make(h).ResolveAsync(new PrReference("o", "r", 1), "PRRT_1", default);
        Assert.True(r.Success);
    }

    [Fact]
    public async Task Resolve_permission_error_maps_to_TokenCannotWrite()
    {
        // NOTE: replace the message below with the live-validated wording (see gate above).
        var h = FakeHandler.Json(HttpStatusCode.OK,
            """{"errors":[{"message":"Resource not accessible by personal access token"}]}""");
        var r = await Make(h).ResolveAsync(new PrReference("o", "r", 1), "PRRT_1", default);
        Assert.False(r.Success);
        Assert.Equal(ReviewThreadErrorCode.TokenCannotWrite, r.ErrorCode);
    }

    [Fact]
    public async Task Resolve_thrown_403_maps_to_TokenCannotWrite()
    {
        var h = FakeHandler.Status(HttpStatusCode.Forbidden); // GitHubGraphQL.PostAsync throws
        var r = await Make(h).ResolveAsync(new PrReference("o", "r", 1), "PRRT_1", default);
        Assert.Equal(ReviewThreadErrorCode.TokenCannotWrite, r.ErrorCode);
    }

    [Fact]
    public async Task Resolve_thrown_429_maps_to_RateLimited()
    {
        var h = FakeHandler.Status(HttpStatusCode.TooManyRequests);
        var r = await Make(h).ResolveAsync(new PrReference("o", "r", 1), "PRRT_1", default);
        Assert.Equal(ReviewThreadErrorCode.RateLimited, r.ErrorCode);
    }

    [Fact]
    public async Task Unresolve_could_not_resolve_node_maps_to_ThreadNotFound()
    {
        var h = FakeHandler.Json(HttpStatusCode.OK,
            """{"errors":[{"message":"Could not resolve to a node with the global id of 'PRRT_x'"}]}""");
        var r = await Make(h).UnresolveAsync(new PrReference("o", "r", 1), "PRRT_x", default);
        Assert.Equal(ReviewThreadErrorCode.ThreadNotFound, r.ErrorCode);
    }
}
```
(Reuse the existing `FakeHandler` / `SingleClientFactory` test doubles from `PRism.GitHub.Tests`; if none exists, add a minimal `HttpMessageHandler` returning the canned response and an `IHttpClientFactory` wrapping it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubReviewThreadWriterTests`
Expected: FAIL — `GitHubReviewThreadWriter` does not exist.

- [ ] **Step 3: Write the writer** (mirror `GitHubPrLifecycleWriter.cs`; classify on BOTH channels)

```csharp
using System.Net;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.GitHub;

internal sealed partial class GitHubReviewThreadWriter : IReviewThreadWriter
{
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly string _host;
    private readonly ILogger<GitHubReviewThreadWriter> _log;

    public GitHubReviewThreadWriter(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, string host,
        ILogger<GitHubReviewThreadWriter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _host = host;
        _log = log ?? NullLogger<GitHubReviewThreadWriter>.Instance;
    }

    public Task<ReviewThreadResult> ResolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        RunAsync(reference, threadId, "resolveReviewThread", ct);

    public Task<ReviewThreadResult> UnresolveAsync(PrReference reference, string threadId, CancellationToken ct) =>
        RunAsync(reference, threadId, "unresolveReviewThread", ct);

    private async Task<ReviewThreadResult> RunAsync(
        PrReference reference, string threadId, string mutation, CancellationToken ct)
    {
        var label = $"{reference.Owner}/{reference.Repo}#{reference.Number}";
        var query = $$"""
            mutation($threadId: ID!) {
              {{mutation}}(input: { threadId: $threadId }) {
                thread { id isResolved }
              }
            }
            """;
        try
        {
            var body = await PostGraphQLAsync(query, new { threadId }, ct).ConfigureAwait(false);
            var code = ClassifyThreadGraphQLError(body);
            if (code is null) return ReviewThreadResult.Ok;      // no errors[]
            Log.ThreadWriteFailed(_log, label, mutation, 200, GitHubHttp.Truncate(body, 1024));
            return ReviewThreadResult.Fail(code.Value);
        }
        catch (HttpRequestException ex) // PostAsync throws on any non-2xx
        {
            Log.ThreadWriteFailed(_log, label, mutation, (int?)ex.StatusCode ?? 0, ex.Message);
            return ReviewThreadResult.Fail(ClassifyHttpStatus(ex.StatusCode));
        }
    }

    private static ReviewThreadErrorCode ClassifyHttpStatus(HttpStatusCode? status) => status switch
    {
        HttpStatusCode.TooManyRequests => ReviewThreadErrorCode.RateLimited,
        HttpStatusCode.Unauthorized => ReviewThreadErrorCode.TokenCannotWrite,
        HttpStatusCode.Forbidden => ReviewThreadErrorCode.TokenCannotWrite,
        _ => ReviewThreadErrorCode.Generic,
    };

    // 200 + errors[] path. Substrings pinned to the LIVE-VALIDATED resolveReviewThread wording.
    private static ReviewThreadErrorCode? ClassifyThreadGraphQLError(string body)
    {
        using var doc = JsonDocument.Parse(body);
        if (!doc.RootElement.TryGetProperty("errors", out var errors)
            || errors.ValueKind != JsonValueKind.Array || errors.GetArrayLength() == 0)
            return null;
        var e0 = errors[0];
        var msg = e0.TryGetProperty("message", out var m) ? (m.GetString() ?? "") : "";
        if (e0.TryGetProperty("type", out var t) && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
            return ReviewThreadErrorCode.RateLimited;
        if (msg.Contains("Could not resolve to a node", StringComparison.OrdinalIgnoreCase))
            return ReviewThreadErrorCode.ThreadNotFound;
        if (msg.Contains("not have permission", StringComparison.OrdinalIgnoreCase)
            || msg.Contains("Resource not accessible", StringComparison.OrdinalIgnoreCase))
            return ReviewThreadErrorCode.TokenCannotWrite;
        return ReviewThreadErrorCode.Generic;
    }

    private async Task<string> PostGraphQLAsync(string query, object variables, CancellationToken ct)
    {
        var token = await _readToken().ConfigureAwait(false);
        using var http = _httpFactory.CreateClient("github");
        return await GitHubGraphQL.PostAsync(http, token, _host, _log, query, variables, ct).ConfigureAwait(false);
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, EventId = 1, EventName = "ReviewThreadWriteFailed",
            Message = "Review-thread write failed: pr={Pr} action={Action} status={Status} body={Body}")]
        internal static partial void ThreadWriteFailed(ILogger logger, string pr, string action, int status, string body);
    }
}
```

- [ ] **Step 4: Register in DI** (verbatim shape of the adjacent `IPrLifecycleWriter` registration, `ServiceCollectionExtensions.cs:96-106` — three services: `IHttpClientFactory`, `ITokenStore`, host from `IConfigStore.Current.Github.Host`)

```csharp
services.AddSingleton<IReviewThreadWriter>(sp => new GitHubReviewThreadWriter(
    sp.GetRequiredService<IHttpClientFactory>(),
    () => sp.GetRequiredService<ITokenStore>().ReadAsync(CancellationToken.None),
    sp.GetRequiredService<IConfigStore>().Current.Github.Host,
    sp.GetRequiredService<ILogger<GitHubReviewThreadWriter>>()));
```

- [ ] **Step 5: Run tests + commit**

Run: `dotnet test tests/PRism.GitHub.Tests --filter GitHubReviewThreadWriterTests` → PASS

```bash
git add PRism.GitHub/GitHubReviewThreadWriter.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/GitHubReviewThreadWriterTests.cs
git commit -m "feat(#571): GitHubReviewThreadWriter (resolve/unresolve GraphQL + dual classification)"
```

---

## Task 3: Event + snapshot invalidation (`ReviewThreadResolutionChanged`)

**Files:**
- Modify: `PRism.Core/Events/SubmitBusEvents.cs` (add the record)
- Modify: `PRism.Core/PrDetail/PrDetailLoader.cs` (subscribe → `Invalidate`; field + `Dispose`)
- Test: `tests/PRism.Core.Tests/PrDetailLoaderReviewThreadInvalidationTests.cs`

**Interfaces:**
- Produces: `record ReviewThreadResolutionChanged(PrReference PrRef) : IReviewEvent`.

- [ ] **Step 1: Write the failing test** (publishing the event evicts the snapshot for that prRef)

```csharp
[Fact]
public async Task Publishing_ReviewThreadResolutionChanged_evicts_the_snapshot()
{
    var (loader, bus, prRef) = await SeedLoadedSnapshotAsync(); // existing helper pattern
    loader.TryGetCachedSnapshot(prRef).Should().NotBeNull();

    bus.Publish(new ReviewThreadResolutionChanged(prRef));

    loader.TryGetCachedSnapshot(prRef).Should().BeNull(); // evicted → next read re-materializes
}
```
(Structurally identical to the existing `SingleCommentPostedBusEvent` / `DraftSubmitted` eviction tests in `PrDetailLoaderTests.cs:245-257, 295-298` — `bus.Publish(...)` then assert `TryGetCachedSnapshot` flips `NotBeNull` → `BeNull`. There is no `PrLifecycleChanged` eviction test to mirror; use these.)

- [ ] **Step 2: Run → FAIL** (`ReviewThreadResolutionChanged` undefined).

- [ ] **Step 3: Add the event** (`SubmitBusEvents.cs`, next to `PrLifecycleChanged`)

```csharp
// #571 — a review thread was resolved/unresolved. Like PrLifecycleChanged it does NOT move
// headSha, so PrDetailLoader must Invalidate explicitly; SseChannel fans it out to tabs.
public sealed record ReviewThreadResolutionChanged(PrReference PrRef) : IReviewEvent;
```

- [ ] **Step 4: Subscribe + dispose in `PrDetailLoader`** (mirror `OnPrLifecycleChanged` at `:116,157` and the `Dispose` list at `:351-359`)

```csharp
// ctor, alongside the existing subscriptions:
_reviewThreadResolutionSubscription =
    eventBus.Subscribe<ReviewThreadResolutionChanged>(OnReviewThreadResolutionChanged);

private void OnReviewThreadResolutionChanged(ReviewThreadResolutionChanged evt) => Invalidate(evt.PrRef);

// Dispose():
_reviewThreadResolutionSubscription.Dispose();
```
(Add the `private readonly IDisposable _reviewThreadResolutionSubscription;` field.)

- [ ] **Step 5: Run → PASS + commit**

```bash
git add PRism.Core/Events/SubmitBusEvents.cs PRism.Core/PrDetail/PrDetailLoader.cs tests/PRism.Core.Tests/PrDetailLoaderReviewThreadInvalidationTests.cs
git commit -m "feat(#571): ReviewThreadResolutionChanged event -> PrDetailLoader.Invalidate"
```

---

## Task 4: SSE fanout + projection

**Files:**
- Modify: `PRism.Web/Sse/SseChannel.cs` (subscribe → `FanoutProjected`; field + `Dispose`)
- Modify: `PRism.Web/Sse/SseEventProjection.cs` (projection case + wire record)
- Test: `tests/PRism.Web.Tests/SseEventProjectionTests.cs` (add a case)

**Interfaces:**
- Consumes: `ReviewThreadResolutionChanged` (Task 3).
- Produces: SSE event name `"review-thread-resolution-changed"`, payload `{ prRef }`.

- [ ] **Step 1: Write the failing test** (projection maps the event → wire name + prRef payload)

```csharp
[Fact]
public void Projects_ReviewThreadResolutionChanged_to_wire()
{
    var prRef = new PrReference("o", "r", 1);
    var (name, payload) = SseEventProjection.Project(new ReviewThreadResolutionChanged(prRef));
    Assert.Equal("review-thread-resolution-changed", name);
    Assert.Equal(prRef.ToString(), /* the wire record's prRef field */ GetPrRef(payload));
}
```
(Match the exact `Project` signature/return shape the file uses at `:110`.)

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Add the projection case + wire record** (`SseEventProjection.cs`, mirror `PrLifecycleChangedWire`)

```csharp
ReviewThreadResolutionChanged e => ("review-thread-resolution-changed", new ReviewThreadResolutionChangedWire(e.PrRef.ToString())),
// …
// internal sealed (match the sibling wire records) so the PRism.Web.Tests projection test can
// cast the returned object payload and read PrRef.
internal sealed record ReviewThreadResolutionChangedWire(string PrRef);
```

- [ ] **Step 4: Subscribe + dispose in `SseChannel`** (mirror `_busPrLifecycleChanged` at `:93,357,438`)

```csharp
_busReviewThreadResolutionChanged =
    bus.Subscribe<ReviewThreadResolutionChanged>(e => FanoutProjected(e, e.PrRef));
// Dispose(): _busReviewThreadResolutionChanged.Dispose();
```

- [ ] **Step 5: Run → PASS + commit**

```bash
git add PRism.Web/Sse/SseChannel.cs PRism.Web/Sse/SseEventProjection.cs tests/PRism.Web.Tests/SseEventProjectionTests.cs
git commit -m "feat(#571): SSE fanout + projection for review-thread-resolution-changed"
```

---

## Task 5: Web endpoints (`PrReviewThreadEndpoints`) with `threadId`↔`prRef` binding

**Files:**
- Create: `PRism.Web/Endpoints/PrReviewThreadEndpoints.cs`
- Modify: `PRism.Web/Program.cs` (call `app.MapPrReviewThreadEndpoints();`)
- Test: `tests/PRism.Web.Tests/PrReviewThreadEndpointsTests.cs`

**Interfaces:**
- Consumes: `IReviewThreadWriter` (Task 1/2), `IReviewEventBus`, `IActivePrCache`, `RequireSubscribed`, `TabStamps.TryValidateTabId`, `HttpJson.TryReadJsonAsync<T>`, the PR-detail snapshot source (for the membership check — see Step 3 note).

**Approach.** Mirror `PrLifecycleEndpoints.HandleAsync` gate order exactly, inserting gate 3 (thread membership). Body DTO `record ResolveRequest(string? ThreadId)`.

- [ ] **Step 1: Write the failing tests** (a `WebApplicationFactory`; override `ConfigureWebHost` — NOT `CreateHostBuilder`)

```csharp
public class PrReviewThreadEndpointsTests
{
    [Fact] public async Task Not_subscribed_returns_403_unauthorized() { /* no subscribe → 403 { code:"unauthorized" } */ }

    [Fact] public async Task Missing_tab_id_returns_422_tab_id_missing() { /* subscribed, no X-PRism-Tab-Id header → 422 */ }

    [Fact] public async Task Missing_threadId_returns_400_thread_id_required() { /* subscribed + tab-id, body {} → 400 */ }

    [Fact] public async Task Foreign_threadId_returns_404_thread_not_found()
    { /* subscribed + tab-id, threadId not in the prRef snapshot → 404 { code:"thread-not-found" } */ }

    [Fact] public async Task Resolve_success_publishes_event_and_200()
    {
        // fake IReviewThreadWriter returns Ok; assert 200 AND a ReviewThreadResolutionChanged was published.
    }

    [Fact] public async Task Writer_token_cannot_write_maps_to_403()
    { /* fake writer Fail(TokenCannotWrite) → 403 { code:"token-cannot-write" } */ }
}
```
(Seed the prRef snapshot with a known `threadId` so the membership gate passes for the success/error cases; use a foreign id for the 404 case. Follow `PrLifecycleEndpointsTests` for the subscribe/tab-id harness.)

- [ ] **Step 2: Run → FAIL** (endpoints unmapped).

- [ ] **Step 3: Write the endpoints** (gates 1-2 verbatim from `PrLifecycleEndpoints`; gate 3 is new)

```csharp
using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class PrReviewThreadEndpoints
{
    public static void MapPrReviewThreadEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/thread/resolve",
            (string owner, string repo, int number, HttpContext http,
             IReviewThreadWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             PrDetailLoader loader, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, loader,
                               static (w, r, id, c) => w.ResolveAsync(r, id, c), writer, ct));

        app.MapPost("/api/pr/{owner}/{repo}/{number:int:min(1)}/thread/unresolve",
            (string owner, string repo, int number, HttpContext http,
             IReviewThreadWriter writer, IReviewEventBus bus, IActivePrCache activePrCache,
             PrDetailLoader loader, CancellationToken ct)
                => HandleAsync(owner, repo, number, http, bus, activePrCache, loader,
                               static (w, r, id, c) => w.UnresolveAsync(r, id, c), writer, ct));
    }

    // PrDetailLoader is the concrete type (no IPrDetailLoader — single impl); other endpoints
    // inject it directly (PrDetailEndpoints.cs:20).
    private static async Task<IResult> HandleAsync(
        string owner, string repo, int number, HttpContext http,
        IReviewEventBus bus, IActivePrCache activePrCache, PrDetailLoader loader,
        Func<IReviewThreadWriter, PrReference, string, CancellationToken, Task<ReviewThreadResult>> action,
        IReviewThreadWriter writer, CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);

        // Gate 1 — subscribe (verbatim from PrLifecycleEndpoints).
        if (RequireSubscribed.Check(activePrCache, prRef, "Subscribe to this PR before resolving threads.") is { } notSubscribed)
            return notSubscribed;

        // Gate 2 — tab-id CSRF (verbatim).
        if (!TabStamps.TryValidateTabId(http.Request, out _))
            return Results.Json(new { code = "tab-id-missing" }, statusCode: StatusCodes.Status422UnprocessableEntity);

        // Body.
        var req = (await HttpJson.TryReadJsonAsync<ResolveRequest>(http.Request, ct).ConfigureAwait(false)).Value;
        if (req is null || string.IsNullOrEmpty(req.ThreadId))
            return Results.Json(new { code = "thread-id-required" }, statusCode: StatusCodes.Status400BadRequest);

        // Gate 3 — ownership binding (spec §5.4): the threadId must belong to THIS PR's snapshot.
        // Hot path is the in-memory cache; re-hydrate via LoadAsync only if a background evict cleared
        // it (verbatim the PrDetailEndpoints.cs:88-89 hybrid) so a legitimately-evicted snapshot does
        // NOT spurious-404. ReviewComments lives on snapshot.Detail (PrDetailSnapshot = Detail/HeadSha/Gen).
        var snapshot = loader.TryGetCachedSnapshot(prRef) ?? await loader.LoadAsync(prRef, ct).ConfigureAwait(false);
        if (snapshot is null || !snapshot.Detail.ReviewComments.Any(t => t.ThreadId == req.ThreadId))
            return Results.Json(new { code = "thread-not-found" }, statusCode: StatusCodes.Status404NotFound);

        var result = await action(writer, prRef, req.ThreadId, ct).ConfigureAwait(false);
        if (result.Success)
        {
            bus.Publish(new ReviewThreadResolutionChanged(prRef));
            return Results.Ok();
        }
        var (code, status) = MapError(result.ErrorCode);
        return Results.Json(new { code }, statusCode: status);
    }

    private sealed record ResolveRequest(string? ThreadId);

    private static (string Code, int Status) MapError(ReviewThreadErrorCode code) => code switch
    {
        ReviewThreadErrorCode.TokenCannotWrite => ("token-cannot-write", StatusCodes.Status403Forbidden),
        ReviewThreadErrorCode.ThreadNotFound   => ("thread-not-found",   StatusCodes.Status404NotFound),
        ReviewThreadErrorCode.RateLimited      => ("rate-limited",       StatusCodes.Status429TooManyRequests),
        _                                      => ("generic",            StatusCodes.Status502BadGateway),
    };
}
```

> **Snapshot access seam (verified).** Inject the **concrete** `PrDetailLoader` (there is no `IPrDetailLoader` — single impl; other endpoints inject the class). Use the hot-path-then-rehydrate hybrid `loader.TryGetCachedSnapshot(prRef) ?? await loader.LoadAsync(prRef, ct)` exactly as `PrDetailEndpoints.cs:88-89` does: `TryGetCachedSnapshot` is a pure in-memory read (free on the hot path), and `LoadAsync` re-hydrates only when a background evict (poller/peer-write/config-reload) cleared the entry — so a legitimately-evicted snapshot is NOT mistaken for a foreign thread and 404'd. `ReviewComments` is `snapshot.Detail.ReviewComments` (`PrDetailSnapshot` = `(Detail, HeadSha, CoefficientsGeneration)`; `PrDetailDto.ReviewComments : IReadOnlyList<ReviewThreadDto>`, `ReviewThreadDto.ThreadId`).

- [ ] **Step 4: Map in `Program.cs`** — add `app.MapPrReviewThreadEndpoints();` next to `app.MapPrLifecycleEndpoints();`.

- [ ] **Step 5: Run tests → PASS + commit**

```bash
git add PRism.Web/Endpoints/PrReviewThreadEndpoints.cs PRism.Web/Program.cs tests/PRism.Web.Tests/PrReviewThreadEndpointsTests.cs
git commit -m "feat(#571): thread resolve/unresolve endpoints with threadId<->prRef binding"
```

---

## Task 6: Frontend SSE event registration

**Files:**
- Modify: `frontend/src/api/types.ts` (add `ReviewThreadResolutionChangedEvent`)
- Modify: `frontend/src/api/events.ts` (import/re-export the type; add to `EventPayloadByType`; add to `EVENT_TYPES`)
- Test: `frontend/src/api/events.test.ts` (or the existing events test — assert the type is registered)

**Interfaces:**
- Produces: `ReviewThreadResolutionChangedEvent = { prRef: string }`; wire key `'review-thread-resolution-changed'`.

- [ ] **Step 1: Write the failing test**

```ts
it('dispatches review-thread-resolution-changed to on() subscribers', () => {
  // Using the existing events test harness (mock EventSource): emit a
  // 'review-thread-resolution-changed' frame and assert the on() callback fires.
  // (If the suite tests EVENT_TYPES membership directly, assert the array includes it.)
});
```

- [ ] **Step 2: Run → FAIL** (`'review-thread-resolution-changed'` not in `EventPayloadByType`, TS error / listener never registered).

- [ ] **Step 3: Register (all three edits — see `events.ts:62-99`)**

```ts
// types.ts
export type ReviewThreadResolutionChangedEvent = { prRef: string };

// events.ts — import + re-export alongside PrLifecycleChangedEvent, then:
export type EventPayloadByType = {
  // …existing…
  'review-thread-resolution-changed': ReviewThreadResolutionChangedEvent;
};
const EVENT_TYPES = [
  // …existing…
  'review-thread-resolution-changed',
] as const satisfies readonly (keyof EventPayloadByType)[];
```

- [ ] **Step 4: Run → PASS** (`npm --prefix frontend run test -- events`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/api/types.ts frontend/src/api/events.ts frontend/src/api/events.test.ts
git commit -m "feat(#571): register review-thread-resolution-changed SSE event"
```

---

## Task 7: Frontend API module (`reviewThread.ts`)

**Files:**
- Create: `frontend/src/api/reviewThread.ts`
- Test: `frontend/src/api/reviewThread.test.ts`

**Interfaces:**
- Produces: `resolveThread(prRef, threadId) : Promise<ThreadActionResult>`, `unresolveThread(prRef, threadId)`; `type ThreadResolutionErrorCode = 'token-cannot-write' | 'thread-not-found' | 'rate-limited' | 'subscribe-rejected' | 'generic'`; `interface ThreadActionResult { ok: boolean; code?: ThreadResolutionErrorCode }`.

- [ ] **Step 1: Write the failing tests** (mirror any existing `prLifecycle.test.ts`)

```ts
import { resolveThread } from './reviewThread';
// mock apiClient.post to resolve (ok) / reject with ApiError({code}) and assert mapping:
//  - resolve → { ok: true }
//  - ApiError body.code 'unauthorized' → { ok:false, code:'subscribe-rejected' }
//  - ApiError body.code 'token-cannot-write' → { ok:false, code:'token-cannot-write' }
//  - unknown code → { ok:false, code:'generic' }
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the module** (mirror `prLifecycle.ts` — body carries `{ threadId }`)

```ts
import { apiClient, ApiError } from './client';
import type { PrReference } from './types';

export type ThreadResolutionErrorCode =
  | 'token-cannot-write' | 'thread-not-found' | 'rate-limited' | 'subscribe-rejected' | 'generic';

export interface ThreadActionResult { ok: boolean; code?: ThreadResolutionErrorCode }

const KNOWN: ReadonlySet<string> = new Set(['token-cannot-write', 'thread-not-found', 'rate-limited']);

function handleThreadError(e: unknown): ThreadActionResult {
  if (e instanceof ApiError) {
    const raw = (e.body as { code?: string } | null | undefined)?.code;
    if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
    return { ok: false, code: raw && KNOWN.has(raw) ? (raw as ThreadResolutionErrorCode) : 'generic' };
  }
  return { ok: false, code: 'generic' };
}

async function run(prRef: PrReference, action: 'resolve' | 'unresolve', threadId: string): Promise<ThreadActionResult> {
  try {
    await apiClient.post(`/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/thread/${action}`, { threadId });
    return { ok: true };
  } catch (e) {
    return handleThreadError(e);
  }
}

export const resolveThread = (prRef: PrReference, threadId: string) => run(prRef, 'resolve', threadId);
export const unresolveThread = (prRef: PrReference, threadId: string) => run(prRef, 'unresolve', threadId);
```

- [ ] **Step 4: Run → PASS + Step 5: Commit**

```bash
git add frontend/src/api/reviewThread.ts frontend/src/api/reviewThread.test.ts
git commit -m "feat(#571): reviewThread API client + code-based error decode"
```

---

## Task 8: SSE subscriber hook (`useReviewThreadResolutionChangedSubscriber`)

**Files:**
- Create: `frontend/src/hooks/useReviewThreadResolutionChangedSubscriber.ts`
- Test: `frontend/src/hooks/useReviewThreadResolutionChangedSubscriber.test.tsx`

**Interfaces:**
- Produces: `useReviewThreadResolutionChangedSubscriber({ prRef, onChanged })` — fires `onChanged()` on a matching-prRef event.

- [ ] **Step 1: Write the failing test** (mirror `useLifecycleChangedSubscriber.test.tsx`): a matching-prRef event calls `onChanged`; a different prRef does not.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the hook** (clone `useLifecycleChangedSubscriber.ts` verbatim, swapping the event name)

```ts
import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseReviewThreadResolutionChangedSubscriberOptions {
  prRef: PrReference | null;
  onChanged: () => void;
}

export function useReviewThreadResolutionChangedSubscriber({
  prRef, onChanged,
}: UseReviewThreadResolutionChangedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('review-thread-resolution-changed', (event) => {
      if (event.prRef !== prRefStr) return;
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onChanged]);
}
```

- [ ] **Step 4: Run → PASS + Step 5: Commit**

```bash
git add frontend/src/hooks/useReviewThreadResolutionChangedSubscriber.ts frontend/src/hooks/useReviewThreadResolutionChangedSubscriber.test.tsx
git commit -m "feat(#571): SSE subscriber hook for thread resolution changes"
```

---

## Task 9: Reconcile hook (`useThreadResolution`) — confirm-then-apply

**Files:**
- Create: `frontend/src/hooks/useThreadResolution.ts`
- Test: `frontend/src/hooks/useThreadResolution.test.tsx`

**Interfaces:**
- Consumes: `resolveThread`/`unresolveThread` (Task 7); a `reload: () => void`, a `clearCollapseOverride: (threadId: string) => void` (Task 11), and the thread's current `isResolved` (from render).
- Produces:
  ```ts
  useThreadResolution(args: {
    prRef: PrReference | null;     // null in pure-render/read-only (no replyContext) — invoke no-ops
    threadId: string; isResolved: boolean;
    reload: () => void; clearCollapseOverride: (id: string) => void;
  }): {
    pending: boolean;              // in-flight → spinner + disabled
    announce: string | null;       // sr-only live-region text ("Resolving…" / "Unresolving…" / null)
    error: string | null;          // inline banner copy (code-keyed) or null
    reconcileHint: boolean;        // write-ok-but-reload-failed soft hint
    invoke: () => void;            // toggles based on isResolved
  }
  ```
  **Rules-of-Hooks note:** `ThreadView` owns the single hook instance (state is shared across the button's two possible positions), so the hook is called **unconditionally**. It must therefore tolerate a `null` `prRef` (pure-render / read-only, where `ThreadView` has no `replyContext`) — `invoke` early-returns when `prRef` is null, and the button isn't rendered in that mode anyway.

**Approach.** A confirm-then-apply clone of `usePrAction`'s single-action path, per-instance, with these #571-specific differences: (a) errors are **inline state** (not a toast); (b) the "target" is `!isResolvedAtClick`; (c) on reconcile release, call `clearCollapseOverride(threadId)`; (d) the fallback-timer path distinguishes reconcile-landed vs reconcile-failed → `reconcileHint`; (e) expose `announce` for the live region. `copyFor` reuses the sibling's `token-cannot-write` / `subscribe-rejected` strings.

- [ ] **Step 1: Write the failing tests** (fake timers; `resolveThread` mocked)

```tsx
// 1. invoke() on an active thread → pending=true, announce='Resolving…', calls resolveThread.
// 2. After the reloaded isResolved flips to target → pending=false, announce=null,
//    clearCollapseOverride(threadId) called, and NO second reload after a fast reconcile
//    (assert reload called exactly once via the SSE path, timer cleared).
// 3. resolveThread rejects/returns {ok:false, code:'token-cannot-write'} → pending=false,
//    error=token-scope copy, no flip, no clearCollapseOverride.
// 4. {ok:false, code:'subscribe-rejected'} → error='This session lost access to the PR. Reload the page.'
// 5. write ok but isResolved never reaches target; fallback fires at 5000ms → reconcileHint=true
//    (not silent), pending released.
// 6. starting a new invoke() clears a prior error before the request resolves.
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3: Write the hook**

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { resolveThread, unresolveThread, type ThreadResolutionErrorCode } from '../api/reviewThread';
import type { PrReference } from '../api/types';

const FALLBACK_MS = 5000;

function copyFor(code: ThreadResolutionErrorCode | undefined): string {
  switch (code) {
    case 'token-cannot-write':
      return "PRism can't resolve this conversation. Grant PR-write access: classic PAT → the `repo` scope; fine-grained PAT → 'Pull requests: Read and write'. If you're not a collaborator, this requires collaborator access.";
    case 'subscribe-rejected':
      return 'This session lost access to the PR. Reload the page.';
    case 'thread-not-found':
      return 'This conversation no longer exists on GitHub. Reload the PR.';
    case 'rate-limited':
      return 'GitHub is rate-limiting requests. Try again shortly.';
    default:
      return 'The action could not be completed. Try again.';
  }
}

export function useThreadResolution({
  prRef, threadId, isResolved, reload, clearCollapseOverride,
}: {
  prRef: PrReference | null; threadId: string; isResolved: boolean;
  reload: () => void; clearCollapseOverride: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [announce, setAnnounce] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileHint, setReconcileHint] = useState(false);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<boolean | null>(null);     // desired isResolved
  const latestResolved = useRef(isResolved);
  latestResolved.current = isResolved;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
  }, []);

  // Release when the reloaded isResolved reaches the target (confirm-then-apply).
  useEffect(() => {
    if (targetRef.current !== null && isResolved === targetRef.current) {
      targetRef.current = null;
      clearTimer();
      setPending(false);
      setAnnounce(null);
      inFlight.current = false;
      clearCollapseOverride(threadId); // so isResolved governs the fold again
    }
  }, [isResolved, clearTimer, clearCollapseOverride, threadId]);

  useEffect(() => clearTimer, [clearTimer]);

  const invoke = useCallback(() => {
    if (!prRef || inFlight.current) return; // null prRef = pure-render/read-only; no-op
    inFlight.current = true;
    const target = !isResolved;
    targetRef.current = target;
    setPending(true);
    setError(null);            // new attempt clears any prior banner
    setReconcileHint(false);
    setAnnounce(target ? 'Resolving…' : 'Unresolving…');
    const call = target ? resolveThread : unresolveThread;
    void call(prRef, threadId)
      .then((r) => {
        if (!r.ok) {
          targetRef.current = null;
          clearTimer();
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          setError(copyFor(r.code));
          return;
        }
        // Success — already reconciled (fast SSE)?
        if (latestResolved.current === target) {
          targetRef.current = null;
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          clearCollapseOverride(threadId);
          return;
        }
        // Hold through the reconcile window; fallback bounds the wait.
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const reconciled = latestResolved.current === targetRef.current;
          targetRef.current = null;
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          if (reconciled) {
            clearCollapseOverride(threadId);
          } else {
            reload();                 // one more try to refresh
            setReconcileHint(true);   // write ok, reload lagging — tell the user (AC7)
          }
        }, FALLBACK_MS);
      })
      .catch(() => {
        targetRef.current = null;
        clearTimer();
        setPending(false);
        setAnnounce(null);
        inFlight.current = false;
        setError(copyFor(undefined));
      });
  }, [prRef, threadId, isResolved, reload, clearCollapseOverride, clearTimer]);

  return { pending, announce, error, reconcileHint, invoke };
}
```

- [ ] **Step 4: Run → PASS** (`npm --prefix frontend run test -- useThreadResolution`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/hooks/useThreadResolution.ts frontend/src/hooks/useThreadResolution.test.tsx
git commit -m "feat(#571): useThreadResolution confirm-then-apply hook"
```

---

## Task 10: Composer slot for the Resolve button

**Files:**
- Modify: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx` (add optional `extraActionStart?: ReactNode`)
- Modify: `frontend/src/components/PrDetail/Composer/ReplyComposer.tsx` (pass it through; `InlineCommentComposer` never does)
- Test: `frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx`

**Interfaces:**
- Produces: `ComposerActionsBarProps.extraActionStart?: ReactNode`, rendered in the right group immediately before the post-now "Comment" button.

- [ ] **Step 1: Write the failing test** — `extraActionStart` node renders, and appears before the "Comment" button in DOM order; absent when not passed.

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3a: Add the slot to `ComposerActionsBar`** (before the `composer-post-now` button at `ComposerActionsBar.tsx:101`)

```tsx
// props: add `extraActionStart?: ReactNode;` (import type { ReactNode } from 'react')
// render, immediately before the post-now button:
{extraActionStart}
<button type="button" className="composer-post-now" /* …unchanged… */>
```

- [ ] **Step 3b: Thread the prop through `ReplyComposer`** — `ComposerActionsBar` is rendered by `ReplyComposer` (`ReplyComposer.tsx:89`, `<ComposerActionsBar {...actions} />`). `ReplyComposer` must accept its own `extraActionStart?: ReactNode` prop and forward it:

```tsx
// ReplyComposerProps: add `extraActionStart?: ReactNode;`
<ComposerActionsBar {...actions} extraActionStart={extraActionStart} />
```

- [ ] **Step 3c: Do NOT touch `InlineCommentComposer`.** It also spreads `{...actions}` into `ComposerActionsBar` (`InlineCommentComposer.tsx:111`) but must NOT gain or pass `extraActionStart` — the new-comment composer has no thread/resolve concept, so the slot stays `undefined` there (no leak). `ThreadView` (Task 12) passes the resolve control node as `ReplyComposer`'s `extraActionStart` only when the composer is open.

- [ ] **Step 4: Run → PASS + Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/Composer/ComposerActionsBar.tsx frontend/src/components/PrDetail/Composer/ReplyComposer.tsx frontend/src/components/PrDetail/Composer/ComposerActionsBar.test.tsx
git commit -m "feat(#571): ComposerActionsBar extraActionStart slot (ReplyComposer-only)"
```

---

## Task 11: Wiring — `reload` + `clearCollapseOverride` to the thread widget; subscriber

**Files:**
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (extend `ExistingCommentWidgetReplyContext` with `reload` + `clearCollapseOverride`)
- Modify: `frontend/src/components/PrDetail/FilesTab/FilesTab.tsx` (provide both; add `clearCollapseOverride`; subscribe)
- Test: `frontend/src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx` (add: override cleared on resolve)

**Interfaces:**
- Produces on `ExistingCommentWidgetReplyContext`: `reload: () => void`; `clearCollapseOverride: (threadId: string) => void`.
- `clearCollapseOverride(threadId)` deletes `overrides[threadId]` from `collapseOverrides` state.

- [ ] **Step 1: Write the failing test** — after `clearCollapseOverride('t1')`, a resolved `t1` that had `override=false` folds (effectiveCollapsed falls back to `isResolved`).

```tsx
// Unit-test the state helper: given overrides {t1:false}, clearCollapseOverride('t1')
// yields {} so effectiveCollapsed({}, 't1', true) === true.
```

- [ ] **Step 2: Run → FAIL** (helper/prop absent).

- [ ] **Step 3: Implement**

```tsx
// FilesTab.tsx — add a deletion helper next to nextOverrides:
export function clearOverride(overrides: Record<string, boolean>, threadId: string): Record<string, boolean> {
  if (!(threadId in overrides)) return overrides;
  const { [threadId]: _drop, ...rest } = overrides;
  return rest;
}
// …in the component:
const clearCollapseOverride = useCallback(
  (threadId: string) => setCollapseOverrides((m) => clearOverride(m, threadId)), []);
// pass `reload` (from usePrDetail) and `clearCollapseOverride` into the replyContext bag.
// subscribe so other tabs reconcile:
useReviewThreadResolutionChangedSubscriber({ prRef, onChanged: reload });
```
```ts
// ExistingCommentWidget.tsx — extend the interface (stable-callback additions; no memo break):
export interface ExistingCommentWidgetReplyContext {
  // …existing…
  reload: () => void;
  clearCollapseOverride: (threadId: string) => void;
}
```

- [ ] **Step 4: Run → PASS + Step 5: Commit**

```bash
git add frontend/src/components/PrDetail/FilesTab/FilesTab.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/src/components/PrDetail/FilesTab/FilesTab.collapse.test.tsx
git commit -m "feat(#571): wire reload + clearCollapseOverride + thread-resolution subscriber"
```

---

## Task 12: The control in the thread widget + CSS

**Files:**
- Modify: `frontend/src/styles/tokens.css` (add `.btn-success-outline`)
- Modify: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx` (`ThreadView`: render the control, spinner, live region, focus park, inline error/hint banner)
- Test: `frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.resolution.test.tsx`

**Interfaces:**
- Consumes: `useThreadResolution` (Task 9), the composer slot (Task 10), `reload`/`clearCollapseOverride` (Task 11).

- [ ] **Step 1: Write the failing tests**

```tsx
// - Active thread renders "Resolve conversation" (class btn-success-outline); resolved renders
//   "Unresolve conversation" (btn-secondary).
// - Click → button disabled + spinner; an sr-only role="status" announces "Resolving…".
// - After the parent re-renders with isResolved=true → button gone (thread folds) / label flips.
// - token-cannot-write → full-width role="alert" banner with the scope copy; state unchanged.
// - reconcileHint → the "resolved — couldn't refresh, reload" hint renders.
// - readOnly → the control is disabled.
// - Pure render (NO replyContext): no Resolve/Unresolve button renders and nothing throws
//   (the hook is called with prRef=null). Keep the existing pure-render ExistingCommentWidget tests green.
// - Focus: clicking parks focus on the thread root (div[data-thread-id]) before disabling.
```

- [ ] **Step 2: Run → FAIL.**

- [ ] **Step 3a: Add the CSS** (`tokens.css`, in the Button section)

```css
.btn-success-outline { background: var(--surface-1); color: var(--success-fg); border-color: var(--success); }
.btn-success-outline:hover:not(:disabled) { background: var(--success-soft); border-color: var(--success); color: var(--success-fg); }
```

- [ ] **Step 3b: Render the control in `ThreadView`** (uses the hook; button in the actions row + composer slot; focus park; sr-only live region; inline banner)

```tsx
// module scope — stable no-op fallbacks so the hook's useCallback deps don't churn:
const NOOP = () => {};

// inside ThreadView, after computing `thread`. The hook is called UNCONDITIONALLY (Rules of
// Hooks); it tolerates a null prRef (pure-render / read-only has no replyContext), and the button
// below is only rendered when replyContext exists, so invoke() is never reachable with a null prRef.
const { pending, announce, error, reconcileHint, invoke } = useThreadResolution({
  prRef: replyContext?.prRef ?? null,
  threadId: thread.threadId,
  isResolved: thread.isResolved,
  reload: replyContext?.reload ?? NOOP,
  clearCollapseOverride: replyContext?.clearCollapseOverride ?? NOOP,
});
const rootRef = useRef<HTMLDivElement>(null);
const onResolveClick = () => { rootRef.current?.focus(); invoke(); };

const resolveButton = replyContext ? (
  <button
    type="button"
    className={`btn btn-sm ${thread.isResolved ? 'btn-secondary' : 'btn-success-outline'}`}
    disabled={pending || replyContext.readOnly}
    aria-disabled={pending || replyContext.readOnly || undefined}
    aria-busy={pending || undefined}
    onClick={onResolveClick}
  >
    {pending
      ? (<><span className="spinner" aria-hidden="true" /> {thread.isResolved ? 'Unresolving…' : 'Resolving…'}</>)
      : (thread.isResolved ? 'Unresolve conversation' : 'Resolve conversation')}
  </button>
) : null;

// root div gets ref + tabIndex={-1} so it can receive parked focus:
<div ref={rootRef} tabIndex={-1} className={`comment-thread${thread.isResolved ? ' comment-thread--resolved' : ''} …`} data-thread-id={thread.threadId}>
  …
  {/* composer-closed: actions row — resolveButton right-aligned next to Reply… */}
  {/* composer-open: pass resolveButton as ReplyComposer's extraActionStart (Task 10) */}
  {announce && <span className="sr-only" role="status" aria-live="polite">{announce}</span>}
  {(error || reconcileHint) && (
    <div className="err" role="alert">{error ?? 'Resolved — couldn’t refresh. Reload the PR to see the change.'}</div>
  )}
</div>
```
(Use the existing `.err`/spinner conventions; `.err` is the full-width inline banner treatment from the spec §6.4. Render `resolveButton` in the `comment-thread-actions` row when the composer is closed, and pass it as `extraActionStart` to `ReplyComposer` when open — Task 10 slot.)

- [ ] **Step 4: Run → PASS** (`npm --prefix frontend run test -- ExistingCommentWidget`).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.tsx frontend/src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget.resolution.test.tsx
git commit -m "feat(#571): resolve/unresolve control in the thread widget (green-outline, a11y, inline error)"
```

---

## Task 13: Full-suite verification + visual validation

**Files:** none (verification only).

- [ ] **Step 1: Backend** — `dotnet test` (full solution) → all green.
- [ ] **Step 2: Frontend** — `npm --prefix frontend run test` (full vitest) + `npm --prefix frontend run lint` (prettier --check + eslint) + `tsc -b` → all green.
- [ ] **Step 3: Live visual validation (B1 gate evidence).** Launch via `run.ps1 -Reset None --no-browser` against the real DataDir; open a real PR with review threads (per the repo's live-validation notes); resolve + unresolve a thread; capture both-theme screenshots of: active (green-outline Resolve), in-flight spinner, resolved (folded summary), expanded → Unresolve, and a forced error banner. Confirm they match the approved mockup.
- [ ] **Step 4: Assemble the PR `## Proof`** — acceptance-criteria checklist with test/screenshot refs; secrets scan; doc-review dispositions (from the spec's review round); the live-validated classifier note (Task 2).

> **E2E (deferred):** a resolve happy-path e2e depends on #453's `/test/seed-review-thread` hook. If it has landed, add `frontend/e2e/…resolve-thread.spec.ts` (seed → resolve → assert collapsed `Resolved` summary). Otherwise note the gap in Proof.

---

## Self-Review (author checklist — completed)

- **Spec coverage:** writer (T1/2), endpoint+binding (T5), event/invalidate (T3), SSE+registration (T4/T6), api+error-decode (T7), subscriber (T8), reconcile hook incl. clearTimer/reconcile-hint/collapse-clear/focus/live-region (T9/T12), composer slot (T10), control+CSS (T12), two-403 disambiguation (T7/T9/T12), a11y (T9/T12). Deferrals (targeted-patch, imported-drafts, e2e) carried from the spec. ✔
- **Placeholders:** the only intentional "confirm the exact seam" notes are the DI token/host wiring (Task 2 Step 4) and the `IPrDetailLoader` snapshot-read method (Task 5 Step 3) — both are "match the adjacent sibling / confirm the real signature," not unfinished logic; the live-validation gate (Task 2) is a required manual step, flagged. ✔
- **Type consistency:** `ReviewThreadErrorCode`/`ReviewThreadResult`/`ReviewThreadResolutionChanged`/`review-thread-resolution-changed`/`useThreadResolution`/`clearCollapseOverride`/`extraActionStart` used identically across tasks. ✔
