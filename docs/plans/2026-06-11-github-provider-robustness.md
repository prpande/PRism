# GitHub Provider Robustness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden the PRism GitHub provider's inbox read-path against five robustness defects (#322's four findings + #361's terminal-CI TTL) without changing any wire contract or UI.

**Architecture:** Additive, provider-internal. Four new small support types (`InboxCacheEviction`, `InboxJsonGuard`, `GitHubLinkHeader`, `GitHubRestContractException`), one DI wiring addition (`IClock`→`SystemClock`), and focused edits to four inbox readers + two single-comment write paths. TDD throughout; backend-only (.NET 10).

**Tech Stack:** C# / .NET 10, xUnit + FluentAssertions, `System.Text.Json`, `Microsoft.Extensions.*` DI & logging. Spec: `docs/specs/2026-06-11-github-provider-robustness-design.md`.

**Worktree:** `D:\src\PRism-322`, branch `feature/322-github-provider-robustness`.

**Test-harness facts (verified):**
- `FakeHttpMessageHandler(Func<HttpRequestMessage,HttpResponseMessage>)`; statics `.Returns(status, body, headers)`, `.Throws(ex)`.
- `FakeHttpClientFactory(HttpMessageHandler handler, Uri baseAddress)` — **two args, always pass `new Uri("https://api.github.com/")`**.
- `PaginatedFakeHandler().RouteJson(pathPrefix, page1, page2, …)` emits `Link rel="next"` between pages and 500s on over-call; `CallCountFor(pathPrefix)` returns the page index reached.
- `RecordingHttpMessageHandler(HttpStatusCode, body)` exposes `RequestCount`, `RequestPaths`, `RequestBodies`, `RequestMethods`.
- `PRism.GitHub.Tests` already has `InternalsVisibleTo` for `PRism.GitHub` internals.
- Endpoint tests (`PRism.Web.Tests`): inline uses `CommentTestContext.Create()`, `ctx.SeedSessionAsync(o,r,n,session)`, `ctx.Post(n, draftId)`, `ctx.Submitter.InjectReviewCommentFailure(ex)`; root uses `RootCommentTestContext.Create()`, `SessionWithRootDraft()`, `ctx.Post(n)`, `ctx.Submitter.InjectFailure(ex)`. **Important:** the existing failure tests assert *different* codes depending on the injected `HttpRequestException` — the inline test injects a network error → `github-network-error`; the root test injects a 403 → `github-forbidden`. A non-`HttpRequestException` (our `GitHubRestContractException`) falls to each endpoint's `catch (Exception)` catch-all → **`github-network-error` (502/BadGateway) in BOTH**. So the new contract-exception tests assert `github-network-error`, which matches the inline file's existing failure test but NOT the root file's 403 test.

**Build/test commands** (run one at a time, foreground, timeout ≥ 300000ms):
- GitHub tests: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "<name>"`
- Web tests: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "<name>"`
- Full backend before PR: `dotnet test PRism.sln`

**Task order & file-sharing:** `GitHubAwaitingAuthorFilter.cs` is edited by Tasks 4 (eviction) + 5 (pagination/logger/isolation); `GitHubCiFailingDetector.cs` by Tasks 1 (Link-helper swap) + 4 (eviction) + 6 (TTL); `ServiceCollectionExtensions.cs` by Tasks 5 + 6. The `InboxCacheEviction.PruneAbsent` helper is generic over the cache value type, so Task 4 (added while the detector cache is `CiStatus`) keeps working unchanged after Task 6 changes the value to `CacheEntry`.

---

### Task 1: Shared support types

Create the four new types and rewire the detector to the extracted Link helper. No inbox behavior changes yet — the detector's existing pagination tests guard the extraction.

**Files:**
- Create: `PRism.GitHub/Inbox/InboxCacheEviction.cs`
- Create: `PRism.GitHub/Inbox/InboxJsonGuard.cs`
- Create: `PRism.GitHub/GitHubLinkHeader.cs`
- Create: `PRism.GitHub/GitHubRestContractException.cs`
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` (delete private `TryGetNextLink`, call `GitHubLinkHeader.TryGetNext`)
- Test: `tests/PRism.GitHub.Tests/Inbox/InboxCacheEvictionTests.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/InboxJsonGuardTests.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubRestContractExceptionTests.cs`

- [ ] **Step 1: Write failing tests for the four new types**

`tests/PRism.GitHub.Tests/Inbox/InboxCacheEvictionTests.cs`:
```csharp
using System.Collections.Concurrent;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class InboxCacheEvictionTests
{
    private static PrReference Pr(int n) => new("o", "r", n);

    [Fact]
    public void Prunes_keys_whose_PrReference_is_absent_from_live()
    {
        var cache = new ConcurrentDictionary<(PrReference, string), int>();
        cache[(Pr(1), "sha")] = 1;
        cache[(Pr(2), "sha")] = 2;

        InboxCacheEviction.PruneAbsent(cache, new HashSet<PrReference> { Pr(1) });

        cache.ContainsKey((Pr(1), "sha")).Should().BeTrue();
        cache.ContainsKey((Pr(2), "sha")).Should().BeFalse();
    }

    [Fact]
    public void Empty_live_set_prunes_everything()
    {
        var cache = new ConcurrentDictionary<(PrReference, DateTimeOffset), int>();
        cache[(Pr(1), DateTimeOffset.UnixEpoch)] = 1;

        InboxCacheEviction.PruneAbsent(cache, new HashSet<PrReference>());

        cache.Should().BeEmpty();
    }
}
```

`tests/PRism.GitHub.Tests/Inbox/InboxJsonGuardTests.cs`:
```csharp
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class InboxJsonGuardTests
{
    [Theory]
    [InlineData(typeof(KeyNotFoundException))]
    [InlineData(typeof(InvalidOperationException))]
    [InlineData(typeof(FormatException))]
    public void Recognizes_malformed_item_exception_types(Type t)
        => InboxJsonGuard.IsMalformedItem((Exception)Activator.CreateInstance(t)!).Should().BeTrue();

    [Fact]
    public void Recognizes_JsonException()
        => InboxJsonGuard.IsMalformedItem(new JsonException("x")).Should().BeTrue();

    [Theory]
    [InlineData(typeof(OperationCanceledException))]
    [InlineData(typeof(HttpRequestException))]
    public void Does_not_swallow_transport_or_cancellation(Type t)
        => InboxJsonGuard.IsMalformedItem((Exception)Activator.CreateInstance(t)!).Should().BeFalse();

    [Fact]
    public void Does_not_swallow_rate_limit()
        => InboxJsonGuard.IsMalformedItem(
            new RateLimitExceededException("x", TimeSpan.FromSeconds(1))).Should().BeFalse();
}
```

`tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs`:
```csharp
using System.Net;
using FluentAssertions;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubLinkHeaderTests
{
    private static HttpResponseMessage WithLink(string? link)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK);
        if (link is not null) r.Headers.TryAddWithoutValidation("Link", link);
        return r;
    }

    [Fact]
    public void Returns_next_url_when_present()
    {
        using var resp = WithLink(
            "<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        GitHubLinkHeader.TryGetNext(resp).Should().Be(new Uri("https://api.github.com/x?page=2"));
    }

    [Fact]
    public void Returns_null_when_only_last()
    {
        using var resp = WithLink("<https://api.github.com/x?page=9>; rel=\"last\"");
        GitHubLinkHeader.TryGetNext(resp).Should().BeNull();
    }

    [Fact]
    public void Returns_null_when_no_link_header()
    {
        using var resp = WithLink(null);
        GitHubLinkHeader.TryGetNext(resp).Should().BeNull();
    }
}
```

`tests/PRism.GitHub.Tests/GitHubRestContractExceptionTests.cs`:
```csharp
using FluentAssertions;
using PRism.GitHub;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubRestContractExceptionTests
{
    [Fact]
    public void Carries_message()
        => new GitHubRestContractException("boom").Message.Should().Be("boom");

    [Fact]
    public void Is_not_an_HttpRequestException()
        => new GitHubRestContractException("x").Should().NotBeAssignableTo<HttpRequestException>();
}
```

- [ ] **Step 2: Run the new tests to verify they fail (types don't exist yet)**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~InboxCacheEvictionTests|FullyQualifiedName~InboxJsonGuardTests|FullyQualifiedName~GitHubLinkHeaderTests|FullyQualifiedName~GitHubRestContractExceptionTests"`
Expected: FAIL (compile error — `InboxCacheEviction`, `InboxJsonGuard`, `GitHubLinkHeader`, `GitHubRestContractException` not defined).

- [ ] **Step 3: Create `PRism.GitHub/Inbox/InboxCacheEviction.cs`**

```csharp
using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Per-tick cache pruning shared by the three inbox readers. Each reader holds a
/// process-lifetime cache keyed by (PrReference, T); after a tick we drop every key
/// whose PrReference is absent from the current snapshot so the map stays bounded by
/// live inbox size. The second key component (head SHA / UpdatedAt) is irrelevant to
/// eviction — a PR leaving the inbox removes all of its keys regardless. (#322)
/// </summary>
internal static class InboxCacheEviction
{
    public static void PruneAbsent<TKey2, TValue>(
        ConcurrentDictionary<(PrReference, TKey2), TValue> cache,
        IReadOnlyCollection<PrReference> live)
    {
        var liveSet = live as HashSet<PrReference> ?? new HashSet<PrReference>(live);
        foreach (var key in cache.Keys)
        {
            if (!liveSet.Contains(key.Item1))
                cache.TryRemove(key, out _);
        }
    }
}
```

- [ ] **Step 4: Create `PRism.GitHub/Inbox/InboxJsonGuard.cs`**

```csharp
using System.Text.Json;

namespace PRism.GitHub.Inbox;

/// <summary>
/// True for the exception set that signals a single malformed JSON item (a missing
/// property, a wrong value kind, an unparseable timestamp, or a non-JSON body) — as
/// opposed to a transport failure, cancellation, or rate-limit, which must still
/// propagate and abort the tick. Used to isolate one poisoned inbox item from the
/// rest of the batch. (#322)
/// </summary>
internal static class InboxJsonGuard
{
    public static bool IsMalformedItem(Exception ex) =>
        ex is KeyNotFoundException     // GetProperty on a missing key
           or InvalidOperationException // wrong JsonValueKind (GetString/GetInt32/EnumerateArray)
           or FormatException           // parse failures, e.g. GetDateTimeOffset on a bad string
           or JsonException;            // JsonDocument.Parse on a non-JSON body
}
```

- [ ] **Step 5: Create `PRism.GitHub/GitHubLinkHeader.cs` (body moved verbatim from the detector's private `TryGetNextLink`)**

```csharp
namespace PRism.GitHub;

/// <summary>
/// Parses a GitHub <c>Link</c> response header and returns the absolute URL whose
/// attributes include <c>rel="next"</c>, or null if none. Format:
/// <c>&lt;url1&gt;; rel="next", &lt;url2&gt;; rel="last"</c>. Node IDs / URLs are opaque —
/// the absolute URL is handed straight back to HttpClient. (#322; extracted from
/// GitHubCiFailingDetector so the reviews walk can share it.)
/// </summary>
internal static class GitHubLinkHeader
{
    public static Uri? TryGetNext(HttpResponseMessage resp)
    {
        if (!resp.Headers.TryGetValues("Link", out var values)) return null;
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;
                var hasNext = false;
                for (var i = 1; i < segments.Length; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals("rel=\"next\"", StringComparison.Ordinal)
                        || attr.Equals("rel=next", StringComparison.Ordinal))
                    {
                        hasNext = true;
                        break;
                    }
                }
                if (!hasNext) continue;
                var url = urlSegment[1..^1];
                if (Uri.TryCreate(url, UriKind.Absolute, out var uri)) return uri;
            }
        }
        return null;
    }
}
```

- [ ] **Step 6: Create `PRism.GitHub/GitHubRestContractException.cs`**

```csharp
namespace PRism.GitHub;

/// <summary>
/// Thrown when a GitHub REST endpoint returns a 2xx whose body violates the
/// expected contract (e.g. a created-comment response missing 'id' or 'created_at').
/// Distinguishes "transport succeeded but the payload is malformed" from a genuine
/// non-2xx transport failure (HttpRequestException). Mirrors GitHubGraphQLException,
/// which plays the same role for 200-with-errors GraphQL responses. (#322)
/// </summary>
public sealed class GitHubRestContractException : Exception
{
    public GitHubRestContractException()
        : base("GitHub REST response violated its expected contract.") { }

    public GitHubRestContractException(string message) : base(message) { }

    public GitHubRestContractException(string message, Exception innerException)
        : base(message, innerException) { }
}
```

- [ ] **Step 7: Rewire the detector to the shared Link helper**

In `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`:
1. Replace the call `nextUri = TryGetNextLink(resp);` (in `FetchChecksAsync`) with `nextUri = GitHubLinkHeader.TryGetNext(resp);`.
2. Delete the entire private `private static Uri? TryGetNextLink(HttpResponseMessage resp) { … }` method (and its doc comment).

- [ ] **Step 8: Run the new tests + the detector's existing tests**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~InboxCacheEvictionTests|FullyQualifiedName~InboxJsonGuardTests|FullyQualifiedName~GitHubLinkHeaderTests|FullyQualifiedName~GitHubRestContractExceptionTests|FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: PASS (new types green; the detector's existing pagination tests still pass — the extraction is behavior-preserving).

- [ ] **Step 9: Commit**

```bash
git add PRism.GitHub/Inbox/InboxCacheEviction.cs PRism.GitHub/Inbox/InboxJsonGuard.cs \
        PRism.GitHub/GitHubLinkHeader.cs PRism.GitHub/GitHubRestContractException.cs \
        PRism.GitHub/Inbox/GitHubCiFailingDetector.cs \
        tests/PRism.GitHub.Tests/Inbox/InboxCacheEvictionTests.cs \
        tests/PRism.GitHub.Tests/Inbox/InboxJsonGuardTests.cs \
        tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs \
        tests/PRism.GitHub.Tests/GitHubRestContractExceptionTests.cs
git commit -m "feat(#322): shared support types + extract GitHubLinkHeader"
```

---

### Task 2: U3 — typed REST contract exception

Replace the four `HttpRequestException(…, statusCode: HttpStatusCode.OK)` throws with `GitHubRestContractException`; verify behavior-equivalence at the endpoint.

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.ReviewComments.cs` (lines ~52, ~55; remove `using System.Net;` if now unused)
- Modify: `PRism.GitHub/GitHubReviewService.IssueComments.cs` (lines ~73, ~78; remove `using System.Net;` if now unused)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceIssueCommentsTests.cs` (add contract tests)
- Test: `tests/PRism.GitHub.Tests/GitHubReviewServiceReviewCommentsContractTests.cs` (new)
- Test: `tests/PRism.Web.Tests/Endpoints/PrCommentEndpointTests.cs` (add equivalence test)
- Test: `tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs` (add equivalence test)

- [ ] **Step 1: Write failing service-level tests**

Append to `tests/PRism.GitHub.Tests/GitHubReviewServiceIssueCommentsTests.cs` (inside the class):
```csharp
    // --- malformed-2xx throws GitHubRestContractException (not HttpRequestException) ---

    [Fact]
    public async Task CreateIssueCommentAsync_On2xx_MissingId_ThrowsContractException()
    {
        // 201 Created but body has no "id" → contract violation, NOT a transport error.
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"created_at":"2026-06-02T10:30:00Z"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateIssueCommentAsync(Ref, "hi", CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateIssueCommentAsync_On2xx_MissingCreatedAt_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, """{"id":123}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateIssueCommentAsync(Ref, "hi", CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }
```
Add `using PRism.GitHub;` to the file's usings if not present.

Create `tests/PRism.GitHub.Tests/GitHubReviewServiceReviewCommentsContractTests.cs`:
```csharp
using System.Net;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Submit;
using PRism.GitHub;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public sealed class GitHubReviewServiceReviewCommentsContractTests
{
    private static PrReference Ref => new("owner", "repo", 42);

    private static GitHubReviewService NewService(HttpMessageHandler handler)
        => new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
               () => Task.FromResult<string?>("ghp_test"), "https://github.com");

    private static ReviewCommentRequest SampleReq =>
        new(CommitOid: "deadbeef", FilePath: "src/Foo.cs", LineNumber: 42, Side: "RIGHT",
            BodyMarkdown: "a comment");

    [Fact]
    public async Task CreateReviewCommentAsync_On2xx_MissingId_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.Created, """{"created_at":"2026-06-02T10:30:00Z"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateReviewCommentAsync_On2xx_MissingCreatedAt_ThrowsContractException()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.Created, """{"id":555}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        await act.Should().ThrowAsync<GitHubRestContractException>();
    }

    [Fact]
    public async Task CreateReviewCommentAsync_OnGenuine422_StillThrowsHttpRequestException()
    {
        // Regression: a real non-2xx must remain an HttpRequestException carrying the status.
        var handler = new RecordingHttpMessageHandler(
            HttpStatusCode.UnprocessableEntity, """{"message":"Validation failed"}""");
        var svc = NewService(handler);

        var act = async () => await svc.CreateReviewCommentAsync(Ref, SampleReq, CancellationToken.None);

        var ex = (await act.Should().ThrowAsync<HttpRequestException>()).Which;
        ex.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }
}
```

- [ ] **Step 2: Run the service tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubReviewServiceReviewCommentsContractTests|FullyQualifiedName~CreateIssueCommentAsync_On2xx"`
Expected: FAIL (currently throws `HttpRequestException` for the missing-field cases).

- [ ] **Step 3: Replace the four throws**

In `PRism.GitHub/GitHubReviewService.ReviewComments.cs`, change:
```csharp
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new HttpRequestException("GitHub review comment response missing 'id'.", inner: null, statusCode: HttpStatusCode.OK);
        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new HttpRequestException("GitHub review comment response missing 'created_at'.", inner: null, statusCode: HttpStatusCode.OK);
```
to:
```csharp
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new GitHubRestContractException("GitHub review comment response missing 'id'.");
        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new GitHubRestContractException("GitHub review comment response missing 'created_at'.");
```

In `PRism.GitHub/GitHubReviewService.IssueComments.cs`, change:
```csharp
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new HttpRequestException("GitHub issue comment response missing 'id' field.",
                inner: null, statusCode: HttpStatusCode.OK);

        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new HttpRequestException("GitHub issue comment response missing 'created_at'.",
                inner: null, statusCode: HttpStatusCode.OK);
```
to:
```csharp
        var id = root.TryGetProperty("id", out var idEl) && idEl.ValueKind == JsonValueKind.Number
            ? idEl.GetInt64()
            : throw new GitHubRestContractException("GitHub issue comment response missing 'id' field.");

        var createdAt = root.TryGetProperty("created_at", out var caEl) && caEl.ValueKind == JsonValueKind.String
            ? caEl.GetDateTimeOffset()
            : throw new GitHubRestContractException("GitHub issue comment response missing 'created_at'.");
```

Then in **both** files: the genuine non-2xx throw still uses `statusCode: resp.StatusCode` (an `HttpStatusCode` value, not a namespace reference). If `HttpStatusCode` is no longer referenced by name anywhere in the file, remove `using System.Net;`. Verify by building (Step 4) — if `System.Net` is still needed it will compile either way; prefer removing it only if the build stays green without it.

- [ ] **Step 4: Run the service tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubReviewServiceReviewCommentsContractTests|FullyQualifiedName~GitHubReviewServiceIssueCommentsTests"`
Expected: PASS (malformed-2xx → `GitHubRestContractException`; genuine non-2xx → `HttpRequestException` unchanged).

- [ ] **Step 5: Write failing endpoint behavior-equivalence tests**

Append to `tests/PRism.Web.Tests/Endpoints/PrCommentEndpointTests.cs` (inside the class; mirror the existing `InjectReviewCommentFailure` test at line ~249):
```csharp
    [Fact]
    public async Task PostComment_inline_contract_exception_maps_to_502_github_network_error()
    {
        using var ctx = CommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 1, SessionWithInlineDraft());
        ctx.Submitter.InjectReviewCommentFailure(
            new PRism.GitHub.GitHubRestContractException("missing 'id'"));

        var resp = await ctx.Post(1, "d1");

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        body.GetProperty("code").GetString().Should().Be("github-network-error");
    }
```
> Note: assert the **same** status/code the existing `HttpRequestException` injection test asserts. If that test asserts a status other than `BadGateway`, match it exactly — the point is equivalence, not a specific code.

Append the analogous test to `tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs`. Do **not** copy the existing 403 test's assertions — that test asserts `github-forbidden`, which only applies to an `HttpRequestException` carrying 403. A `GitHubRestContractException` is not an `HttpRequestException`, so it falls to the endpoint's `catch (Exception)` catch-all → `github-network-error`. Use the `RootCommentTestContext` / `SessionWithRootDraft` shape from that file:
```csharp
    [Fact]
    public async Task PostRootComment_contract_exception_maps_to_502_github_network_error()
    {
        using var ctx = RootCommentTestContext.Create();
        await ctx.SeedSessionAsync("o", "r", 24, SessionWithRootDraft());
        ctx.Submitter.InjectFailure(new PRism.GitHub.GitHubRestContractException("missing 'id'"));

        var resp = await ctx.Post(24);

        resp.StatusCode.Should().Be(HttpStatusCode.BadGateway);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>(CamelCase);
        // Not an HttpRequestException ⇒ the catch-all yields github-network-error,
        // NOT the 403 path's github-forbidden.
        body.GetProperty("code").GetString().Should().Be("github-network-error");
    }
```

- [ ] **Step 6: Run the endpoint tests to verify they pass (no production change needed)**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~PrCommentEndpointTests|FullyQualifiedName~PrRootCommentEndpointTests"`
Expected: PASS — the endpoints' `catch (Exception)` catch-all already maps any non-`HttpRequestException` to the same `github-network-error` response. These tests lock that equivalence.

- [ ] **Step 7: Record the consumer grep for `## Proof`**

Run: `dotnet build PRism.sln` (confirms no unused-using breakage) and capture, for the PR body, the result of searching the solution for `catch (HttpRequestException` consumers of `CreateReviewCommentAsync`/`CreateIssueCommentAsync` (use Grep). Expected: only `PrCommentEndpoints` / `PrRootCommentEndpoints`, both with a downstream catch-all.

- [ ] **Step 8: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.ReviewComments.cs PRism.GitHub/GitHubReviewService.IssueComments.cs \
        tests/PRism.GitHub.Tests/GitHubReviewServiceIssueCommentsTests.cs \
        tests/PRism.GitHub.Tests/GitHubReviewServiceReviewCommentsContractTests.cs \
        tests/PRism.Web.Tests/Endpoints/PrCommentEndpointTests.cs \
        tests/PRism.Web.Tests/Endpoints/PrRootCommentEndpointTests.cs
git commit -m "fix(#322): typed GitHubRestContractException for malformed-2xx comment responses"
```

---

### Task 3: U4 — per-item JSON isolation (section runner + enricher)

Isolate malformed JSON items so one poisoned item degrades that item, not the whole section/tick. (The filter's per-review isolation lands in Task 5 with the pagination rewrite.)

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs` (per-item try/catch in `SearchAsync`; add `Log.ItemSkipped`)
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs` (wrap parse+map in `FetchAsync`)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`

- [ ] **Step 1: Write failing tests**

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs`:
```csharp
    [Fact]
    public async Task One_malformed_item_is_skipped_section_keeps_the_good_item()
    {
        // items[] has one valid PR and one missing pull_request.html_url / title.
        const string mixed = """
        {
          "items": [
            {
              "number": 7, "title": "Good PR",
              "user": { "login": "amelia" },
              "updated_at": "2026-05-06T10:00:00Z",
              "comments": 1,
              "pull_request": { "html_url": "https://github.com/acme/api/pull/7" }
            },
            { "number": 8, "user": {} }
          ]
        }
        """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, mixed));
        var sut = BuildSut(handler);

        var result = await sut.QueryAllAsync(new HashSet<string> { "review-requested" }, default);

        result["review-requested"].Should().ContainSingle();
        result["review-requested"][0].Reference.Number.Should().Be(7);
    }
```
> `Respond` already exists in this test file (used by other tests). If not visible, add the helper used elsewhere in the file.

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`:
```csharp
    [Fact]
    public async Task Malformed_pr_detail_is_dropped_other_prs_still_enriched()
    {
        // PR 1 returns a body missing "head"; PR 2 returns a valid body. PR 1 is dropped,
        // PR 2 survives — one poisoned PR detail must not abort the whole enrich tick.
        var handler = new FakeHttpMessageHandler(req =>
        {
            var isPr1 = req.RequestUri!.AbsolutePath.EndsWith("/pulls/1", StringComparison.Ordinal);
            return Respond(HttpStatusCode.OK, isPr1 ? """{"additions":1}""" : PullsResponse);
        });
        var sut = BuildSut(handler);

        var result = await sut.EnrichAsync([Raw(1), Raw(2)], default);

        result.Should().ContainSingle();
        result[0].Reference.Number.Should().Be(2);
    }

    [Fact]
    public async Task Transient_5xx_on_one_pr_still_propagates()
    {
        // A 5xx is a transport failure, NOT a malformed item — it must propagate (the JSON
        // guard does not swallow it), so the poller can skip and retry the whole tick.
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.InternalServerError, "{}"));
        var sut = BuildSut(handler);

        var act = async () => await sut.EnrichAsync([Raw(1)], default);

        await act.Should().ThrowAsync<HttpRequestException>();
    }
```

- [ ] **Step 2: Run to verify the malformed-item tests fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~One_malformed_item_is_skipped|FullyQualifiedName~Malformed_pr_detail_is_dropped|FullyQualifiedName~Transient_5xx_on_one_pr"`
Expected: the two malformed tests FAIL (currently the throw aborts → empty section / exception). `Transient_5xx` may already pass (5xx already propagates via `EnsureSuccessStatusCode`) — that's fine, keep it as a regression guard.

- [ ] **Step 3: Isolate per-item mapping in `GitHubSectionQueryRunner.SearchAsync`**

Wrap the body of the `foreach (var item in items.EnumerateArray())` loop so a malformed item is skipped. The `items.EnumerateArray()` call stays outside the try (a non-array body is a section-level failure). Result:
```csharp
        foreach (var item in items.EnumerateArray())
        {
            try
            {
                var prUrl = item.GetProperty("pull_request").GetProperty("html_url").GetString() ?? "";
                if (!Uri.TryCreate(prUrl, UriKind.Absolute, out var prUri)) continue;
                var path = prUri.AbsolutePath.Trim('/').Split('/');
                if (path.Length < 4 || path[2] != "pull") continue;
                if (!int.TryParse(path[3], out var n)) continue;

                var repo = $"{path[0]}/{path[1]}";
                var userEl = item.GetProperty("user");
                var login = userEl.GetProperty("login").GetString() ?? "";
                var avatarUrl = userEl.TryGetProperty("avatar_url", out var av) && av.ValueKind == JsonValueKind.String
                    ? av.GetString() : null;
                var title = item.GetProperty("title").GetString() ?? "";
                var updated = item.GetProperty("updated_at").GetDateTimeOffset();
                var comments = item.TryGetProperty("comments", out var c) ? c.GetInt32() : 0;

                result.Add(new RawPrInboxItem(
                    new PrReference(path[0], path[1], n),
                    title, login, repo,
                    updated, updated,
                    comments,
                    0, 0,
                    "",
                    1,
                    AvatarUrl: avatarUrl));
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                Log.ItemSkipped(_log, ex);
            }
        }
```
Add `using PRism.Core.Inbox;`? It's already imported. Ensure `using PRism.GitHub.Inbox;` is not needed (same namespace). Add the `ItemSkipped` source-gen message to the nested `Log` class:
```csharp
        [LoggerMessage(Level = LogLevel.Debug, Message = "GitHub search item skipped (malformed JSON shape)")]
        internal static partial void ItemSkipped(ILogger logger, Exception ex);
```

- [ ] **Step 4: Isolate parse+map in `GitHubPrEnricher.FetchAsync`**

Keep the HTTP send, `EnsureSuccessStatusCode()`, and `ReadAsStringAsync` outside the try. Wrap from `JsonDocument.Parse` through the `return raw with { … }`:
```csharp
        var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        try
        {
            using var doc = JsonDocument.Parse(body);
            var head = doc.RootElement.GetProperty("head").GetProperty("sha").GetString() ?? "";
            var additions = doc.RootElement.TryGetProperty("additions", out var a) ? a.GetInt32() : 0;
            var deletions = doc.RootElement.TryGetProperty("deletions", out var d) ? d.GetInt32() : 0;
            var commits = doc.RootElement.TryGetProperty("commits", out var c) ? c.GetInt32() : 1;

            DateTimeOffset pushedAt = raw.UpdatedAt;
            if (doc.RootElement.TryGetProperty("head", out var headEl) &&
                headEl.TryGetProperty("repo", out var headRepo) &&
                headRepo.ValueKind == System.Text.Json.JsonValueKind.Object &&
                headRepo.TryGetProperty("pushed_at", out var pushedAtProp) &&
                pushedAtProp.ValueKind == System.Text.Json.JsonValueKind.String)
            {
                pushedAt = pushedAtProp.GetDateTimeOffset();
            }

            DateTimeOffset? mergedAt = null;
            if (doc.RootElement.TryGetProperty("merged_at", out var mAt) &&
                mAt.ValueKind == JsonValueKind.String)
                mergedAt = mAt.GetDateTimeOffset();

            DateTimeOffset? closedAt = null;
            if (doc.RootElement.TryGetProperty("closed_at", out var cAt) &&
                cAt.ValueKind == JsonValueKind.String)
                closedAt = cAt.GetDateTimeOffset();

            return raw with
            {
                HeadSha = head, Additions = additions, Deletions = deletions,
                IterationNumberApprox = commits, PushedAt = pushedAt,
                MergedAt = mergedAt, ClosedAt = closedAt,
            };
        }
        catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
        {
            return null; // one malformed PR detail skips that PR (caller drops nulls); no logger here by design
        }
```
Add `using PRism.GitHub.Inbox;`? Same namespace — not needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubSectionQueryRunnerTests|FullyQualifiedName~GitHubPrEnricherTests"`
Expected: PASS (malformed item/PR skipped; section/tick preserved; 5xx still throws).

- [ ] **Step 6: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs PRism.GitHub/Inbox/GitHubPrEnricher.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubSectionQueryRunnerTests.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs
git commit -m "fix(#322): per-item JSON isolation in section runner + enricher"
```

---

### Task 4: U1 — bound the three inbox caches

Evict cache keys for PRs absent from the current snapshot; clear on an empty tick.

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Modify: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`

- [ ] **Step 1: Write failing 3-tick eviction tests**

> All three test files already have a `BuildSut(...)` helper and the `Raw(...)`/`Respond(...)` fixtures used below — these tests *append* to existing files, they do not redefine the helper. The detector's `BuildSut(handler)` keeps working here unchanged; Task 6 later adds an optional `IClock?` param (defaulted), so `BuildSut(handler)` still compiles. The eviction tests key request counts on `req.RequestUri.AbsolutePath` (query-stripped), and the non-paginated `FakeHttpMessageHandler` emits no `Link` header — so even after Task 5's pagination rewrite the filter's walk stays single-page and these counts remain stable.

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`:
```csharp
    [Fact]
    public async Task Evicts_absent_pr_cache_entry_observed_on_reinclusion()
    {
        // 3-tick: {1,2} populate → {1} only (evicts 2) → {1,2} again ⇒ PR2 re-probed.
        var perUrl = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var key = req.RequestUri!.AbsolutePath;
            perUrl[key] = perUrl.TryGetValue(key, out var v) ? v + 1 : 1;
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        var sut = BuildSut(handler);

        var pr1 = Raw(1, "head1"); var pr2 = Raw(2, "head2");
        await sut.FilterAsync(ViewerLogin, [pr1, pr2], default);   // tick 1: 1 req each
        await sut.FilterAsync(ViewerLogin, [pr1], default);        // tick 2: pr1 cached, evict pr2
        await sut.FilterAsync(ViewerLogin, [pr1, pr2], default);   // tick 3: pr2 re-probed

        perUrl["/repos/acme/api/pulls/1/reviews"].Should().Be(1, "PR1 stayed cached across all ticks");
        perUrl["/repos/acme/api/pulls/2/reviews"].Should().Be(2, "PR2 was evicted in tick 2, re-probed in tick 3");
    }

    [Fact]
    public async Task Empty_tick_clears_cache()
    {
        var perUrl = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var key = req.RequestUri!.AbsolutePath;
            perUrl[key] = perUrl.TryGetValue(key, out var v) ? v + 1 : 1;
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        var sut = BuildSut(handler);

        var pr1 = Raw(1, "head1");
        await sut.FilterAsync(ViewerLogin, [pr1], default);  // populate
        await sut.FilterAsync(ViewerLogin, [], default);     // empty → clear
        await sut.FilterAsync(ViewerLogin, [pr1], default);  // re-probe (cache was cleared)

        perUrl["/repos/acme/api/pulls/1/reviews"].Should().Be(2);
    }
```

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs` (hold `UpdatedAt` constant so a re-probe can only be eviction):
```csharp
    [Fact]
    public async Task Evicts_absent_pr_cache_entry_observed_on_reinclusion()
    {
        var fixedTs = new DateTimeOffset(2026, 5, 6, 10, 0, 0, TimeSpan.Zero);
        var perUrl = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var key = req.RequestUri!.AbsolutePath;
            perUrl[key] = perUrl.TryGetValue(key, out var v) ? v + 1 : 1;
            return Respond(HttpStatusCode.OK, PullsResponse);
        });
        var sut = BuildSut(handler);

        var pr1 = Raw(1, fixedTs); var pr2 = Raw(2, fixedTs);
        await sut.EnrichAsync([pr1, pr2], default);
        await sut.EnrichAsync([pr1], default);
        await sut.EnrichAsync([pr1, pr2], default);

        perUrl["/repos/acme/api/pulls/1"].Should().Be(1);
        perUrl["/repos/acme/api/pulls/2"].Should().Be(2);
    }
```

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs` (use the frozen default clock — do NOT advance it; the detector probes `/check-runs` + `/status`, so count by PR via the path):
```csharp
    [Fact]
    public async Task Evicts_absent_pr_cache_entry_observed_on_reinclusion()
    {
        // Count check-runs probes per PR number. Frozen default clock ⇒ TTL never expires,
        // so a tick-3 re-probe is attributable to eviction alone, not TTL.
        var perPr = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.Contains("/check-runs", StringComparison.Ordinal))
                perPr[path] = perPr.TryGetValue(path, out var v) ? v + 1 : 1;
            if (path.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, FailingCheckRun);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        var pr1 = Raw(1, "head1"); var pr2 = Raw(2, "head2");
        await sut.DetectAsync([pr1, pr2], default);
        await sut.DetectAsync([pr1], default);
        await sut.DetectAsync([pr1, pr2], default);

        perPr["/repos/acme/api/commits/head1/check-runs"].Should().Be(1);
        perPr["/repos/acme/api/commits/head2/check-runs"].Should().Be(2);
    }
```
> `FailingCheckRun` / `SuccessNoLegacyStatus` already exist in the detector test file. Failing is cacheable (terminal), which is what we want for the eviction assertion.

- [ ] **Step 2: Run to verify the eviction tests fail**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Evicts_absent_pr_cache_entry|FullyQualifiedName~Empty_tick_clears_cache"`
Expected: FAIL (no eviction yet — PR2 stays cached, so its re-probe count is 1 not 2).

- [ ] **Step 3: Add eviction to `GitHubPrEnricher.EnrichAsync`**

Empty path → clear; after `Task.WhenAll` → prune:
```csharp
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) { _cache.Clear(); return Array.Empty<RawPrInboxItem>(); }
```
and immediately after `var done = await Task.WhenAll(...).ConfigureAwait(false);`:
```csharp
        InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
```

- [ ] **Step 4: Add eviction to `GitHubAwaitingAuthorFilter.FilterAsync`**

Empty path (note the variable is `candidates`):
```csharp
        ArgumentNullException.ThrowIfNull(candidates);
        if (candidates.Count == 0) { _lastReviewShaCache.Clear(); return Array.Empty<RawPrInboxItem>(); }
```
after `Task.WhenAll`:
```csharp
        InboxCacheEviction.PruneAbsent(_lastReviewShaCache, candidates.Select(c => c.Reference).ToHashSet());
```

- [ ] **Step 5: Add eviction to `GitHubCiFailingDetector.DetectAsync`**

Empty path:
```csharp
        ArgumentNullException.ThrowIfNull(items);
        if (items.Count == 0) { _cache.Clear(); return new CiDetectResult(Array.Empty<(RawPrInboxItem, CiStatus)>(), true); }
```
after `var done = await Task.WhenAll(...).ConfigureAwait(false);`:
```csharp
        InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
```

- [ ] **Step 6: Run the eviction tests + full inbox suite to verify pass & no regressions**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Inbox"`
Expected: PASS (all eviction + empty-clear tests green; pre-existing inbox tests unaffected).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubPrEnricher.cs PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs \
        PRism.GitHub/Inbox/GitHubCiFailingDetector.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "fix(#322): bound the three inbox caches via per-tick absent-PR eviction"
```

---

### Task 5: U2 — correct reviews pagination + filter logger + per-review isolation

Rewrite `FetchLastReviewShaAsync` to Link-walk all pages, add an `ILogger` for the page-cap signal, and isolate malformed review items.

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs` (mark `sealed partial`; ctor ILogger; rewrite fetch; `Log` class)
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (pass `ILogger<GitHubAwaitingAuthorFilter>`)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`

- [ ] **Step 1: Write failing pagination tests**

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`:
```csharp
    [Fact]
    public async Task Most_recent_review_on_page_2_is_used_not_page_1()
    {
        // Reviews are ascending: page 1 holds the OLDER review (at "old"), page 2 the NEWER
        // (at "head"). The viewer's latest review IS at head ⇒ PR is excluded. The single-page
        // bug would read page-1 "old" != head ⇒ wrongly include the PR.
        var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old" } ]""";
        var page2 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head" } ]""";
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", page1, page2);
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().BeEmpty("the page-2 review at head means the viewer reviewed the current head");
        handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(2);
    }

    [Fact]
    public async Task Single_page_with_no_next_link_returns_page_1_best()
    {
        var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old" } ]""";
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", page1);
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().ContainSingle("last review at 'old' != head ⇒ awaiting author");
        handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(1);
    }

    [Fact]
    public async Task Malformed_review_item_is_skipped_scan_continues()
    {
        // One review missing user.login is skipped; a later valid viewer review still counts.
        var page1 = $$"""
            [ { "user": {} },
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old" } ]
            """;
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", page1);
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().ContainSingle();
    }
```
> `BuildSut` here passes a `FakeHttpMessageHandler`; add an overload accepting any `HttpMessageHandler` so `PaginatedFakeHandler` works:
```csharp
    private static GitHubAwaitingAuthorFilter BuildSut(HttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));
```
Keep the existing `FakeHttpMessageHandler` overload (it satisfies `HttpMessageHandler`, so a single `HttpMessageHandler` overload suffices — remove the narrower one if it causes ambiguity).

- [ ] **Step 2: Run to verify the page-2 test fails**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Most_recent_review_on_page_2|FullyQualifiedName~Single_page_with_no_next_link|FullyQualifiedName~Malformed_review_item_is_skipped"`
Expected: `Most_recent_review_on_page_2` FAILs (single-page code reads page 1 → wrongly includes the PR; also over-calls the handler? No — it reads page 1 once and stops, so `CallCountFor` == 1, failing the `Be(2)` assert). The other two may pass already.

- [ ] **Step 3: Rewrite the filter — `partial`, ILogger, Link-walk, per-item isolation**

In `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`:

1. Add usings: `using Microsoft.Extensions.Logging;` and `using Microsoft.Extensions.Logging.Abstractions;`.
2. Change the class declaration to `public sealed partial class GitHubAwaitingAuthorFilter : IAwaitingAuthorFilter`.
3. Add a logger field + ctor param:
```csharp
    private readonly ILogger<GitHubAwaitingAuthorFilter> _log;

    public GitHubAwaitingAuthorFilter(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        ILogger<GitHubAwaitingAuthorFilter>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _log = log ?? NullLogger<GitHubAwaitingAuthorFilter>.Instance;
    }
```
4. Replace `FetchLastReviewShaAsync` with the paginated walk:
```csharp
    private const int MaxReviewPages = 10;

    private async Task<string?> FetchLastReviewShaAsync(
        PrReference pr, string viewerLogin, string? token, CancellationToken ct)
    {
        string? best = null;
        Uri? nextUri = null;
        var initialUrl = $"repos/{pr.Owner}/{pr.Repo}/pulls/{pr.Number}/reviews?per_page=100";
        using var http = _httpFactory.CreateClient("github");

        var page = 0;
        for (; page < MaxReviewPages; page++)
        {
            using var req = nextUri is null
                ? new HttpRequestMessage(HttpMethod.Get, initialUrl)
                : new HttpRequestMessage(HttpMethod.Get, nextUri);
            if (!string.IsNullOrEmpty(token))
                req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            req.Headers.UserAgent.ParseAdd("PRism/0.1");
            req.Headers.Accept.ParseAdd("application/vnd.github+json");

            using var resp = await http.SendAsync(req, ct).ConfigureAwait(false);
            if (resp.StatusCode == HttpStatusCode.NotFound) return best;
            if (resp.StatusCode == HttpStatusCode.TooManyRequests)
                throw new RateLimitExceededException(
                    "GitHub rate-limited (429); orchestrator should skip this tick.",
                    resp.Headers.RetryAfter?.Delta);
            resp.EnsureSuccessStatusCode();

            var body = await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            using var doc = JsonDocument.Parse(body);
            foreach (var review in doc.RootElement.EnumerateArray())
            {
                try
                {
                    var login = review.GetProperty("user").GetProperty("login").GetString();
                    if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;
                    var sha = review.TryGetProperty("commit_id", out var s) ? s.GetString() : null;
                    if (sha != null) best = sha; // ascending order → last seen overall = most recent
                }
                catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
                {
                    Log.ReviewItemSkipped(_log, ex, pr.Owner, pr.Repo, pr.Number);
                }
            }

            nextUri = GitHubLinkHeader.TryGetNext(resp);
            if (nextUri is null) break;
        }

        if (page >= MaxReviewPages && nextUri is not null)
            Log.ReviewPagesCapped(_log, pr.Owner, pr.Repo, pr.Number, MaxReviewPages);

        return best;
    }
```
5. Add the source-gen `Log` class at the end of the class body:
```csharp
    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "GitHub reviews pagination hit the {Cap}-page cap for {Owner}/{Repo}#{Number}; most-recent review may be truncated")]
        internal static partial void ReviewPagesCapped(ILogger logger, string owner, string repo, int number, int cap);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "GitHub review item skipped (malformed JSON shape) for {Owner}/{Repo}#{Number}")]
        internal static partial void ReviewItemSkipped(ILogger logger, Exception ex, string owner, string repo, int number);
    }
```
> `InboxJsonGuard` and `GitHubLinkHeader` are in `PRism.GitHub.Inbox` / `PRism.GitHub` respectively; the filter is in `PRism.GitHub.Inbox` so `GitHubLinkHeader` needs `using PRism.GitHub;` (add it).

- [ ] **Step 4: Wire the logger in DI**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, the `IAwaitingAuthorFilter` registration:
```csharp
        services.AddSingleton<IAwaitingAuthorFilter>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubAwaitingAuthorFilter(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetRequiredService<ILogger<GitHubAwaitingAuthorFilter>>());
        });
```
(`using Microsoft.Extensions.Logging;` is already imported in this file.)

- [ ] **Step 5: Run the filter tests to verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubAwaitingAuthorFilterTests"`
Expected: PASS (page-2 review correctly used; single-page + malformed-item + existing tests green).

- [ ] **Step 6: Add a page-cap signal test**

Append to `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`:
```csharp
    [Fact]
    public async Task Page_cap_is_honored_and_does_not_loop_forever()
    {
        // 11 scripted pages, each with a rel="next" → the walk must stop at MaxReviewPages (10)
        // and return without throwing or over-calling.
        var pages = Enumerable.Range(1, 11)
            .Select(_ => $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old" } ]""")
            .ToArray();
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", pages);
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        await act.Should().NotThrowAsync();
        handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(10);
    }
```
Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~Page_cap_is_honored"`
Expected: PASS (exactly 10 pages walked, no over-call 500).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs PRism.GitHub/ServiceCollectionExtensions.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
git commit -m "fix(#322): Link-walk reviews pagination + cap signal + per-review isolation"
```

---

### Task 6: U5 — terminal CI TTL via injected clock (folds #361)

Inject `IClock`, stamp cache entries, and re-validate a cached terminal status after a 2-minute TTL.

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` (cache value → `CacheEntry`; `IClock`; TTL read)
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (register `IClock`→`SystemClock`; pass it)
- Create: `tests/PRism.GitHub.Tests/TestHelpers/MutableClock.cs`
- Modify: `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs` (`BuildSut` threading; TTL tests)

- [ ] **Step 1: Create the test clock**

`tests/PRism.GitHub.Tests/TestHelpers/MutableClock.cs`:
```csharp
using PRism.Core.Time;

namespace PRism.GitHub.Tests.TestHelpers;

internal sealed class MutableClock : IClock
{
    public DateTime UtcNow { get; set; } = new(2026, 6, 11, 12, 0, 0, DateTimeKind.Utc);
    public void Advance(TimeSpan by) => UtcNow = UtcNow.Add(by);
}
```

- [ ] **Step 2: Update `BuildSut` and write failing TTL tests**

In `tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs`, change the single `BuildSut` helper to thread a clock (fixes all call sites at once):
```csharp
    private static GitHubCiFailingDetector BuildSut(FakeHttpMessageHandler handler, IClock? clock = null) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"),
            clock ?? new MutableClock());
```
Add usings: `using PRism.Core.Time;` and (if not already) `using PRism.GitHub.Tests.TestHelpers;`.

Append the TTL tests:
```csharp
    [Fact]
    public async Task Terminal_status_within_TTL_is_served_from_cache_without_reprobe()
    {
        var clock = new MutableClock();
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            return req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, FailingCheckRun)
                : Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler, clock);

        var pr = Raw(1, "headX");
        await sut.DetectAsync([pr], default);
        var first = requestCount;
        clock.Advance(TimeSpan.FromSeconds(30)); // still within the 2-min TTL
        await sut.DetectAsync([pr], default);

        requestCount.Should().Be(first, "a terminal status within the TTL is served from cache");
    }

    [Fact]
    public async Task Terminal_status_past_TTL_is_reprobed()
    {
        var clock = new MutableClock();
        var checkRunsBody = FailingCheckRun;
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, checkRunsBody)
                : Respond(HttpStatusCode.OK, SuccessNoLegacyStatus));
        var sut = BuildSut(handler, clock);

        var pr = Raw(1, "headX");
        var r1 = await sut.DetectAsync([pr], default);
        r1.Items[0].Item2.Should().Be(CiStatus.Failing);

        // Same SHA "re-run": CI flips to in-progress. Advance past the TTL → re-probe picks it up.
        checkRunsBody = InProgressCheckRun;
        clock.Advance(TimeSpan.FromMinutes(3));
        var r2 = await sut.DetectAsync([pr], default);

        r2.Items[0].Item2.Should().Be(CiStatus.Pending, "past the TTL the same-SHA re-run is re-probed");
    }
```
> `InProgressCheckRun` already exists in the detector test file (declared near the other fixtures).

- [ ] **Step 3: Run to verify the TTL tests fail (and existing detector tests still compile via the new BuildSut)**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: the two TTL tests FAIL (no TTL yet: the second `DetectAsync` after advancing still returns the cached Failing / never expires). All other detector tests still PASS (frozen default clock keeps within-TTL hits intact).

- [ ] **Step 4: Add the clock + TTL to the detector**

In `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`:

1. Add `using PRism.Core.Time;`.
2. Replace the cache field + add clock + TTL + entry type:
```csharp
    private const int ConcurrencyCap = 8;
    private static readonly TimeSpan TerminalTtl = TimeSpan.FromMinutes(2);
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly IClock _clock;
    private readonly ConcurrentDictionary<(PrReference, string), CacheEntry> _cache = new();

    private readonly record struct CacheEntry(CiStatus Status, DateTime CachedAtUtc);

    public GitHubCiFailingDetector(
        IHttpClientFactory httpFactory, Func<Task<string?>> readToken, IClock clock)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _clock = clock;
    }
```
3. In the per-item lambda, replace the cache READ:
```csharp
                if (!forceReprobe
                    && _cache.TryGetValue(key, out var entry)
                    && _clock.UtcNow - entry.CachedAtUtc <= TerminalTtl)
                    return (Item: c, Ci: entry.Status, Degraded: false);
```
4. Replace the cache WRITE:
```csharp
                if (!degraded && ci != CiStatus.Pending)
                {
                    _cache[key] = new CacheEntry(ci, _clock.UtcNow);
                }
                else if (forceReprobe && !degraded && ci == CiStatus.Pending)
                {
                    _cache.TryRemove(key, out _);
                }
```
(The `InboxCacheEviction.PruneAbsent(_cache, …)` call from Task 4 is generic over the value type and needs no change.)

- [ ] **Step 5: Register `IClock` and pass it in DI**

In `PRism.GitHub/ServiceCollectionExtensions.cs`:
1. Add usings: `using Microsoft.Extensions.DependencyInjection.Extensions;` and `using PRism.Core.Time;`.
2. Near the top of `AddPrismGitHub` (after `ArgumentNullException.ThrowIfNull(services);`):
```csharp
        services.TryAddSingleton<IClock, SystemClock>();
```
3. Update the `ICiFailingDetector` registration:
```csharp
        services.AddSingleton<ICiFailingDetector>(sp =>
        {
            var tokens = sp.GetRequiredService<ITokenStore>();
            var factory = sp.GetRequiredService<IHttpClientFactory>();
            return new GitHubCiFailingDetector(
                factory,
                () => tokens.ReadAsync(CancellationToken.None),
                sp.GetRequiredService<IClock>());
        });
```

- [ ] **Step 6: Run the detector tests to verify pass**

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~GitHubCiFailingDetectorTests"`
Expected: PASS (TTL within → cached; past TTL → re-probe to Pending; forceReprobe + eviction + all prior tests green).

- [ ] **Step 7: Add a DI-resolution test that actually exercises the `IClock` wiring**

`ServiceRegistrationTests` builds the provider **without** `ValidateOnBuild`, and its existing test only resolves `IGitHubCredentialHealth` — so the `ICiFailingDetector` factory lambda (which calls `sp.GetRequiredService<IClock>()`) never runs, and a missing `IClock` registration would NOT be caught. Add a test that forces the lambda to execute. Append to `tests/PRism.GitHub.Tests/ServiceRegistrationTests.cs`:
```csharp
    [Fact]
    public void Resolves_ci_failing_detector_with_clock_dependency()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IConfigStore>(/* the same stub the existing test uses */ null!);
        // ^ Use whatever IConfigStore / ITokenStore stubs the existing RegistersCredentialHealthSingleton
        //   test already wires up; AddPrismGitHub needs them. Mirror that setup exactly.
        services.AddPrismGitHub();
        using var sp = services.BuildServiceProvider();

        sp.GetRequiredService<PRism.Core.Inbox.ICiFailingDetector>().Should().NotBeNull();
    }
```
> Read the existing `RegistersCredentialHealthSingleton` test first and replicate its exact service-stub setup (it already registers whatever `AddPrismGitHub` requires). The key assertion is that resolving `ICiFailingDetector` runs the factory lambda → `GetRequiredService<IClock>()` → would throw if `TryAddSingleton<IClock, SystemClock>()` were omitted.

Run: `dotnet test tests/PRism.GitHub.Tests/PRism.GitHub.Tests.csproj --filter "FullyQualifiedName~ServiceRegistrationTests"`
Expected: PASS (the detector resolves; `IClock`→`SystemClock` is wired). Sanity-check: temporarily commenting out the `TryAddSingleton<IClock, SystemClock>()` line makes THIS test fail (`Unable to resolve IClock`) — proving it guards the wiring.

- [ ] **Step 8: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubCiFailingDetector.cs PRism.GitHub/ServiceCollectionExtensions.cs \
        tests/PRism.GitHub.Tests/TestHelpers/MutableClock.cs \
        tests/PRism.GitHub.Tests/Inbox/GitHubCiFailingDetectorTests.cs
git commit -m "fix(#361): terminal CI status TTL via injected IClock"
```

---

### Final verification (before PR)

- [ ] **Run the full backend suite**

Run: `dotnet test PRism.sln`
Expected: ALL green.

- [ ] **Run the repo pre-push checklist** per `.ai/docs/development-process.md` (build, format/lint — verify prettier via `rtk proxy npx prettier` is N/A here since backend-only; run the .NET formatters the checklist names).

- [ ] **File the U2 selection follow-up issue** (null-`commit_id` "latest review" + sort-order-robust selection) and link it in the spec's Out-of-scope section + the PR body.

- [ ] **Hand off to pr-autopilot** with the `## Proof` material (per-AC test names + results, the `catch (HttpRequestException` consumer grep, the B2-off confirmation for finding #3, full-suite result).

---

## Self-Review

**1. Spec coverage:**
- AC1 (cache eviction, 3 caches) → Task 4. ✓
- AC2 (reviews pagination Link-walk + cap signal) → Task 5. ✓
- AC3 (no `HttpRequestException` with 2xx status) → Task 2 (4 throws replaced) + tests. ✓
- AC4 (per-item isolation, 3 sites) → Task 3 (section runner + enricher) + Task 5 (filter per-review). ✓
- AC5 (terminal CI TTL via clock) → Task 6. ✓
- Shared helpers + Link extraction → Task 1. ✓
- U2 selection residual → documented; follow-up filed in Final verification. ✓

**2. Placeholder scan:** One deliberate "copy the existing test body" instruction in Task 2 Step 5 for `PrRootCommentEndpointTests` — the existing `InjectFailure(HttpRequestException)` test is the authoritative shape and copying it verbatim (swapping the exception type) is more reliable than my reconstructing its context/session setup blind. Acceptable; the surrounding test (`PrCommentEndpointTests`) is given in full as the pattern.

**3. Type consistency:** `InboxCacheEviction.PruneAbsent`, `InboxJsonGuard.IsMalformedItem`, `GitHubLinkHeader.TryGetNext`, `GitHubRestContractException`, `CacheEntry(CiStatus, DateTime)`, `MutableClock`, `GitHubCiFailingDetector(IHttpClientFactory, Func<Task<string?>>, IClock)`, the `Log` members (`ItemSkipped`, `ReviewItemSkipped`, `ReviewPagesCapped`) — names are consistent across tasks and match the spec.
