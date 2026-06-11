# GitHub HTTP Transport Helper Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract the duplicated GitHub HTTP plumbing in `PRism.GitHub` (request headers, 429 handling, Link-header parsing, error-body reads) into two static helpers and route all 10 classes through them — closing the `X-GitHub-Api-Version` drift and a latent GHES pagination bug, behavior-preserving on github.com.

**Architecture:** Two new `internal static` classes in `PRism.GitHub` — `GitHubHttp` (header application + send + same-host credential guard + 429 throw + best-effort error-body read + the shared `ConcurrencyCap`) and `GitHubLinkHeader` (one RFC-8288 `rel` extractor returning the absolute URL). Call sites resolve the token at their current cadence and pass it in. Behavior-preserving except (a) the intended `X-GitHub-Api-Version` addition on previously-omitting REST calls and (b) the GHES `/api/v3/`-doubling pagination fix from unifying the `next`-link adapters to absolute URLs.

**Tech Stack:** .NET 10 (`net10.0`), `Microsoft.Extensions.Http` (`IHttpClientFactory`), `System.Text.Json`, xUnit (test project `PRism.GitHub.Tests`, already wired via `InternalsVisibleTo`).

**Spec:** `docs/specs/2026-06-11-github-transport-helper-design.md` (T3, hands-off, 2× ce-doc-review applied).

**Source of truth for the design decisions:** the spec. This plan implements §4.1–§4.7, §8. Deferred (do NOT do here): group E (`pulls/{n}` union record), page-size consolidation, the submit *envelope* in `Submit.cs`.

---

## File structure

**New production files**
- `PRism.GitHub/GitHubHttp.cs` — static transport helper.
- `PRism.GitHub/GitHubLinkHeader.cs` — static Link-header `rel` extractor.

**New test files**
- `tests/PRism.GitHub.Tests/GitHubHttpTests.cs`
- `tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs`
- `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (characterization pins)

**Modified production files** (call-site migrations; satellite copies deleted)
- `PRism.GitHub/GitHubReviewService.cs` (headers, `SendGitHubAsync`, `PostGraphQLAsync`, `TryParseLastPage`, `ExtractNextLink`→deleted, `ReadActor`, `ConcurrencyCap`, timeline fragment consts)
- `PRism.GitHub/GitHubReviewService.ReviewComments.cs` / `.IssueComments.cs` (error-body read)
- `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`, `GitHubPrEnricher.cs`, `GitHubAwaitingAuthorFilter.cs`, `GitHubCiFailingDetector.cs` (headers, 429, Link, `ConcurrencyCap`)
- `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs`, `GitHubNotificationsReader.cs`, `GitHubWatchedReposReader.cs`, `GitHubPrTimelineReader.cs` (headers)
- `PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs` (headers)

**Conventions to follow** (observed in the codebase):
- `<Nullable>enable</Nullable>` + warnings-as-errors: keep `string?` explicit where a `null` is assigned to a URL variable.
- The named `"github"` client carries no default `Authorization`; every caller attaches per request.
- The token is read via `Func<Task<string?>> _readToken`; an empty/null token means **anonymous** (no `Authorization` header), never an error.

---

## Task 1: `GitHubHttp` static helper

**Files:**
- Create: `PRism.GitHub/GitHubHttp.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubHttpTests.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.GitHub.Tests/GitHubHttpTests.cs`:

```csharp
using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Inbox; // RateLimitExceededException
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubHttpTests
{
    // Captures the outgoing request so assertions can inspect headers/URI.
    private sealed class CapturingHandler : HttpMessageHandler
    {
        public HttpRequestMessage? Last;
        public HttpResponseMessage Response = new(HttpStatusCode.OK);
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
        {
            Last = request;
            return Task.FromResult(Response);
        }
    }

    private static HttpClient Client(CapturingHandler h, string baseAddress = "https://api.github.com/")
        => new(h) { BaseAddress = new Uri(baseAddress) };

    [Fact]
    public async Task SendAsync_attaches_standard_headers_and_version()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, "user", "tok", CancellationToken.None);

        var req = h.Last!;
        Assert.Equal("PRism/0.1", req.Headers.UserAgent.ToString());
        Assert.Contains("application/vnd.github+json", req.Headers.Accept.ToString());
        Assert.True(req.Headers.TryGetValues("X-GitHub-Api-Version", out var v) && v.Single() == "2022-11-28");
        Assert.Equal("Bearer", req.Headers.Authorization!.Scheme);
        Assert.Equal("tok", req.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task SendAsync_empty_token_sends_no_authorization()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, "user", token: null, CancellationToken.None);
        Assert.Null(h.Last!.Headers.Authorization);
    }

    [Fact]
    public async Task SendAsync_accept_override_replaces_default()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, "x", "tok", CancellationToken.None,
            accept: "application/vnd.github.raw");
        Assert.Equal("application/vnd.github.raw", h.Last!.Headers.Accept.ToString());
    }

    [Fact]
    public async Task SendAsync_apiVersion_false_sends_no_version_header()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Post, "graphql", "tok", CancellationToken.None,
            apiVersion: false);
        Assert.False(h.Last!.Headers.Contains("X-GitHub-Api-Version"));
    }

    [Fact]
    public async Task SendAsync_same_host_absolute_url_attaches_token()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get,
            "https://api.github.com/repositories/1/pulls?page=2", "tok", CancellationToken.None);
        Assert.Equal("tok", h.Last!.Headers.Authorization!.Parameter);
    }

    [Fact]
    public async Task SendAsync_off_host_absolute_url_with_token_throws()
    {
        var h = new CapturingHandler();
        using var http = Client(h);
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://evil.example.com/steal", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_graphql_endpoint_passes_host_guard_on_ghes()
    {
        var h = new CapturingHandler();
        using var http = Client(h, "https://ghe.corp.example/api/v3/");
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Post,
            "https://ghe.corp.example/api/graphql", "tok", CancellationToken.None, apiVersion: false);
        Assert.Equal("tok", h.Last!.Headers.Authorization!.Parameter);
    }

    [Fact]
    public void ThrowIfRateLimited_throws_on_429_with_retry_after()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        resp.Headers.RetryAfter = new RetryConditionHeaderValue(TimeSpan.FromSeconds(30));
        var ex = Assert.Throws<RateLimitExceededException>(() => GitHubHttp.ThrowIfRateLimited(resp));
        Assert.Equal(TimeSpan.FromSeconds(30), ex.RetryAfter);
    }

    [Fact]
    public void ThrowIfRateLimited_subject_preserves_search_message()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests);
        var ex = Assert.Throws<RateLimitExceededException>(
            () => GitHubHttp.ThrowIfRateLimited(resp, " Search API"));
        Assert.Contains("Search API", ex.Message);
    }

    [Fact]
    public void ThrowIfRateLimited_noop_on_success()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.OK);
        GitHubHttp.ThrowIfRateLimited(resp); // must not throw
    }

    [Fact]
    public async Task ReadErrorBodyBestEffortAsync_returns_body()
    {
        using var resp = new HttpResponseMessage(HttpStatusCode.BadRequest)
        { Content = new StringContent("boom") };
        Assert.Equal("boom", await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_off_host_with_null_base_address_throws()
    {
        var h = new CapturingHandler();
        using var http = new HttpClient(h); // no BaseAddress
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://api.github.com/x", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_same_host_different_port_with_token_throws()
    {
        var h = new CapturingHandler();
        using var http = Client(h); // BaseAddress https://api.github.com/ (port 443)
        await Assert.ThrowsAsync<HttpRequestException>(() =>
            GitHubHttp.SendAsync(http, HttpMethod.Get, "https://api.github.com:8080/x", "tok", CancellationToken.None));
    }

    [Fact]
    public async Task SendAsync_passes_absolute_ghes_url_through_without_doubling_prefix()
    {
        // Proves the §4.2 GHES fix: passing the absolute Link URL avoids the /api/v3/api/v3/
        // doubling that re-resolving a relative path against BaseAddress would cause.
        var h = new CapturingHandler();
        using var http = Client(h, "https://ghe.corp.example/api/v3/");
        const string abs = "https://ghe.corp.example/api/v3/repos/o/r/pulls/1/files?page=2";
        using var _ = await GitHubHttp.SendAsync(http, HttpMethod.Get, abs, "tok", CancellationToken.None);
        Assert.Equal(abs, h.Last!.RequestUri!.ToString());
    }
}
```

> `RateLimitExceededException` is in **`PRism.Core.Inbox`** (`PRism.Core/Inbox/RateLimitExceededException.cs`), NOT `PRism.Core.Contracts` — verified. It exposes `public TimeSpan? RetryAfter { get; }` and a `(string, TimeSpan?)` ctor. The other throwers (`GitHubCiFailingDetector.cs` etc.) import both namespaces; `GitHubHttp` only needs `PRism.Core.Inbox`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubHttpTests`
Expected: FAIL — `GitHubHttp` does not exist (compile error).

- [ ] **Step 3: Write `GitHubHttp`**

Create `PRism.GitHub/GitHubHttp.cs`:

```csharp
using System.Net;
using System.Net.Http.Headers;
using PRism.Core.Inbox; // RateLimitExceededException

namespace PRism.GitHub;

// #320 — single home for GitHub HTTP request plumbing. Replaces the header set,
// 429 throw, and best-effort error-body read that were hand-copied across 10 classes.
// Static + takes the already-resolved token so each caller keeps its own token-read
// cadence (some read once per batch, some per request); the helper holds no state.
internal static class GitHubHttp
{
    internal const string UserAgent = "PRism/0.1";
    internal const string AcceptJson = "application/vnd.github+json";
    internal const string ApiVersion = "2022-11-28";

    // Inter-batch concurrency cap for per-commit / per-PR fan-out (was declared 4×).
    internal const int ConcurrencyCap = 8;

    // Applies the standard GitHub header set to an existing request. Exposed (vs. only
    // SendAsync) so callers that must set request Options (e.g. the credential-health
    // skip flag) can build their own request and still single-source the headers.
    // Same-host credential guard: the Bearer token is attached only when the request URL
    // is relative (resolved against the trusted BaseAddress) or its host equals the
    // client's BaseAddress host — an off-host absolute URL throws HttpRequestException so
    // the PAT never rides a request to an unexpected host. HttpRequestException (not
    // ArgumentException) is deliberate: paginating callers already degrade on it.
    internal static void ApplyHeaders(
        HttpRequestMessage req, HttpClient http, string? token,
        string? accept = null, bool apiVersion = true)
    {
        if (!string.IsNullOrEmpty(token))
        {
            // Fail CLOSED: a credentialed request must have a URI we can validate.
            var uri = req.RequestUri
                ?? throw new HttpRequestException("Cannot attach GitHub credentials to a request with no RequestUri.");
            if (uri.IsAbsoluteUri)
            {
                if (http.BaseAddress is null)
                    throw new HttpRequestException(
                        "Cannot attach GitHub credentials: the HttpClient has no BaseAddress to validate the request host against.");
                // Compare host AND port. Uri.Host strips the port, so a crafted `host:8080`
                // Link URL — or an http:// downgrade (default port 80 vs the https
                // BaseAddress's 443) — must be caught here, not just a different hostname.
                if (!uri.Host.Equals(http.BaseAddress.Host, StringComparison.OrdinalIgnoreCase)
                    || uri.Port != http.BaseAddress.Port)
                {
                    throw new HttpRequestException(
                        $"Refusing to attach GitHub credentials to off-host URL (request authority '{uri.Authority}', client authority '{http.BaseAddress.Authority}').");
                }
            }
            // A relative URI resolves against the trusted BaseAddress — safe to credential.
            req.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
        }
        req.Headers.UserAgent.ParseAdd(UserAgent);
        req.Headers.Accept.ParseAdd(accept ?? AcceptJson);
        if (apiVersion)
            req.Headers.TryAddWithoutValidation("X-GitHub-Api-Version", ApiVersion);
    }

    // Builds the request, applies the standard headers, attaches optional content, sends.
    // `accept` overrides AcceptJson; `apiVersion:false` suppresses the version header
    // (GraphQL POSTs, which the REST version header does not apply to). The caller owns
    // disposal of the returned response (matches the previous SendGitHubAsync contract).
    internal static async Task<HttpResponseMessage> SendAsync(
        HttpClient http, HttpMethod method, string url, string? token, CancellationToken ct,
        HttpContent? content = null, string? accept = null, bool apiVersion = true)
    {
        using var req = new HttpRequestMessage(method, url);
        ApplyHeaders(req, http, token, accept, apiVersion);
        if (content is not null) req.Content = content;
        return await http.SendAsync(req, ct).ConfigureAwait(false);
    }

    // Replaces the 5 inline 429 blocks. `subject` preserves each site's message exactly:
    // " Search API" for the search-section caller, "" for the other four.
    internal static void ThrowIfRateLimited(HttpResponseMessage resp, string subject = "")
    {
        if (resp.StatusCode == HttpStatusCode.TooManyRequests)
            throw new RateLimitExceededException(
                $"GitHub{subject} rate-limited (429); orchestrator should skip this tick.",
                resp.Headers.RetryAfter?.Delta);
    }

    // The ONE audited CA1031-suppressed best-effort error-body read. Returns the body,
    // or "" on a non-cancellation read failure. OperationCanceledException propagates
    // (caller shutdown), matching the existing convention.
    internal static async Task<string> ReadErrorBodyBestEffortAsync(HttpResponseMessage resp, CancellationToken ct)
    {
        try
        {
            return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // best-effort; the original status is what matters
        catch (Exception)
        {
            return string.Empty;
        }
#pragma warning restore CA1031
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubHttpTests`
Expected: PASS (all 11).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubHttp.cs tests/PRism.GitHub.Tests/GitHubHttpTests.cs
git commit -m "feat(#320): add GitHubHttp static transport helper"
```

---

## Task 2: `GitHubLinkHeader.TryGetRel`

**Files:**
- Create: `PRism.GitHub/GitHubLinkHeader.cs`
- Test: `tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs`

- [ ] **Step 1: Write the failing tests**

Create `tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs`:

```csharp
using System.Net;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubLinkHeaderTests
{
    private static HttpResponseMessage WithLink(string link)
    {
        var r = new HttpResponseMessage(HttpStatusCode.OK);
        r.Headers.TryAddWithoutValidation("Link", link);
        return r;
    }

    [Fact]
    public void TryGetRel_finds_quoted_next()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal("https://api.github.com/x?page=2", url);
    }

    [Fact]
    public void TryGetRel_finds_last()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=\"next\", <https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "last", out var url));
        Assert.Equal("https://api.github.com/x?page=9", url);
    }

    [Fact]
    public void TryGetRel_accepts_unquoted_rel()
    {
        using var r = WithLink("<https://api.github.com/x?page=2>; rel=next");
        Assert.True(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal("https://api.github.com/x?page=2", url);
    }

    [Fact]
    public void TryGetRel_missing_header_returns_false()
    {
        using var r = new HttpResponseMessage(HttpStatusCode.OK);
        Assert.False(GitHubLinkHeader.TryGetRel(r, "next", out var url));
        Assert.Equal(string.Empty, url);
    }

    [Fact]
    public void TryGetRel_rel_absent_returns_false()
    {
        using var r = WithLink("<https://api.github.com/x?page=9>; rel=\"last\"");
        Assert.False(GitHubLinkHeader.TryGetRel(r, "next", out _));
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubLinkHeaderTests`
Expected: FAIL — `GitHubLinkHeader` does not exist.

- [ ] **Step 3: Write `GitHubLinkHeader`**

Create `PRism.GitHub/GitHubLinkHeader.cs`:

```csharp
namespace PRism.GitHub;

// #320 — single RFC-8288 `Link` header parser. Returns the ABSOLUTE URL GitHub put in
// the header for a given rel ("next" | "last" | ...). Replaces three divergent parsers
// (page-number / relative-path / absolute-Uri). Callers adapt the absolute URL to what
// they need (parse &page=, or `new Uri(...)`). Standardizes on quoted-or-unquoted rel
// (GitHub always quotes; the unquoted branch matches the most-tolerant prior parser).
internal static class GitHubLinkHeader
{
    internal static bool TryGetRel(HttpResponseMessage resp, string rel, out string url)
    {
        url = string.Empty;
        if (!resp.Headers.TryGetValues("Link", out var values)) return false;

        var quoted = $"rel=\"{rel}\"";
        var unquoted = $"rel={rel}";
        foreach (var header in values)
        {
            foreach (var part in header.Split(','))
            {
                var segments = part.Split(';');
                if (segments.Length < 2) continue;
                var urlSegment = segments[0].Trim();
                if (!urlSegment.StartsWith('<') || !urlSegment.EndsWith('>')) continue;

                var matched = false;
                for (var i = 1; i < segments.Length && !matched; i++)
                {
                    var attr = segments[i].Trim();
                    if (attr.Equals(quoted, StringComparison.Ordinal)
                        || attr.Equals(unquoted, StringComparison.Ordinal))
                        matched = true;
                }
                if (!matched) continue;

                url = urlSegment[1..^1];
                return true;
            }
        }
        return false;
    }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GitHubLinkHeaderTests`
Expected: PASS (all 5).

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/GitHubLinkHeader.cs tests/PRism.GitHub.Tests/GitHubLinkHeaderTests.cs
git commit -m "feat(#320): add GitHubLinkHeader.TryGetRel"
```

---

## Task 3: Characterization pins (GraphQL byte-identity + submit-path transport)

These tests pin the **current** query strings and submit-path request bytes BEFORE any
refactor, so Tasks 4–8 cannot drift them. Write them, run them green against `main`'s code.

**Files:**
- Test: `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs`

- [ ] **Step 1: Write the characterization tests**

Create `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs`. The two expected strings are
the EXACT current values (copy them verbatim — they are the contract):

```csharp
using Xunit;

namespace PRism.GitHub.Tests;

public class GraphQlByteIdentityTests
{
    // The exact current PrDetailGraphQLQuery (GitHubReviewService.cs). If this test ever
    // fails after Task 4, the timeline-fragment extraction changed the bytes — STOP.
    private const string ExpectedPrDetail =
        "query($owner:String!,$repo:String!,$number:Int!){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "title body url state isDraft mergeable mergeStateStatus " +
        "headRefName baseRefName headRefOid baseRefOid " +
        "author{login avatarUrl} createdAt closedAt mergedAt changedFiles " +
        "comments(first:100){pageInfo{hasNextPage endCursor} nodes{databaseId author{login avatarUrl} createdAt body}}" +
        "reviewThreads(first:100){pageInfo{hasNextPage endCursor} nodes{id path line isResolved " +
        "comments(first:100){nodes{id databaseId author{login avatarUrl} createdAt body lastEditedAt}}}}" +
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
        "pageInfo{hasNextPage endCursor} nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}}" +
        "}}}";

    [Fact]
    public void PrDetailGraphQLQuery_is_byte_identical()
        => Assert.Equal(ExpectedPrDetail, GitHubReviewService.PrDetailGraphQLQuery);
}
```

> `PrDetailGraphQLQuery` is `internal const` and `PRism.GitHub.Tests` has `InternalsVisibleTo`, so the reference compiles. The `GetTimelineAsync` query is a method-local `const` (not reachable from the test); it is pinned indirectly — Task 4 extracts both from the same shared consts, and the PR-detail pin + the integration test 7g (`Frozen_pr_graphql_shape_unchanged`) guard the shape. To pin the timeline copy directly, Task 4 introduces an `internal const string TimelineQuery` (see Task 4, Step 3) and this test gains an assertion for it.

**Submit-path transport byte-identity** (round-2 B2 finding): assert that a submit GraphQL
call emits the same request headers + endpoint as today. Add to the same file:

```csharp
// NOTE: implement after reading GitHubReviewService.Submit.cs to find the lowest-cost
// public submit entry point that calls PostSubmitGraphQLAsync (e.g. a reply/post method),
// OR — if a direct call is impractical — assert the equivalence structurally by routing
// PostGraphQLAsync through GitHubHttp.SendAsync(apiVersion:false) and relying on the
// GitHubHttpTests header assertions. The implementer MUST add at least one test proving a
// submit-path GraphQL request carries: UA "PRism/0.1", Accept "application/vnd.github+json",
// NO "X-GitHub-Api-Version" header, Bearer token, and the GraphQlEndpoint URL — identical
// to pre-refactor. Use a stubbed IHttpClientFactory returning a CapturingHandler client.
```

- [ ] **Step 2: Run to verify GREEN on current code**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GraphQlByteIdentityTests`
Expected: PASS — this characterizes existing behavior. (If `PrDetailGraphQLQuery_is_byte_identical` fails now, the `ExpectedPrDetail` copy has a typo; fix the copy, not the production code.)

- [ ] **Step 3: Commit**

```bash
git add tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs
git commit -m "test(#320): pin GraphQL query byte-identity before refactor"
```

---

## Task 4: Extract the timeline GraphQL fragment (group F)

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs` (the `PrDetailGraphQLQuery` const ~:36-50 and `GetTimelineAsync`'s local `query` ~:350-359)
- Test: `tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs` (add the timeline assertion)

- [ ] **Step 1: Add the shared fragment consts + the timeline pin**

In `GitHubReviewService.cs`, just above `PrDetailGraphQLQuery`, add:

```csharp
// #320 — shared timeline selection, composed byte-identically into PrDetailGraphQLQuery
// (with the pageInfo wrapper) and GetTimelineAsync (without it). Extracting brings the
// GetTimelineAsync copy under the byte-identity test (it was previously unprotected).
internal const string TimelineItemsArgs =
    "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW])";
internal const string TimelineNodes =
    "nodes{__typename " +
    "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
    "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
    "... on PullRequestReview{submittedAt}" +
    "}";
```

Replace the timeline block inside `PrDetailGraphQLQuery` (the lines starting
`"timelineItems(first:100,...){" + "pageInfo{hasNextPage endCursor} nodes{__typename " + ...`)
with the composed form:

```csharp
        TimelineItemsArgs + "{pageInfo{hasNextPage endCursor} " + TimelineNodes + "}" +
```

Promote `GetTimelineAsync`'s method-local `const string query` to an `internal const string
TimelineQuery` field (so the test can pin it), composed from the shared consts:

```csharp
internal const string TimelineQuery = "query($owner:String!,$repo:String!,$number:Int!){" +
    "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
    "comments(first:100){nodes{author{login} createdAt}}" +
    TimelineItemsArgs + "{" + TimelineNodes + "}" +
    "}}}";
```

Then in `GetTimelineAsync`, replace the local `const string query = "...";` with
`const string query = TimelineQuery;` (or use `TimelineQuery` directly at the `PostGraphQLAsync` call).

- [ ] **Step 2: Add the timeline byte-identity assertion**

In `GraphQlByteIdentityTests.cs` add:

```csharp
    private const string ExpectedTimeline =
        "query($owner:String!,$repo:String!,$number:Int!){" +
        "repository(owner:$owner,name:$repo){pullRequest(number:$number){" +
        "comments(first:100){nodes{author{login} createdAt}}" +
        "timelineItems(first:100,itemTypes:[PULL_REQUEST_COMMIT,HEAD_REF_FORCE_PUSHED_EVENT,PULL_REQUEST_REVIEW]){" +
        "nodes{__typename " +
        "... on PullRequestCommit{commit{oid committedDate message additions deletions}} " +
        "... on HeadRefForcePushedEvent{beforeCommit{oid} afterCommit{oid} createdAt} " +
        "... on PullRequestReview{submittedAt}" +
        "}}" +
        "}}}";

    [Fact]
    public void TimelineQuery_is_byte_identical()
        => Assert.Equal(ExpectedTimeline, GitHubReviewService.TimelineQuery);
```

- [ ] **Step 3: Run the byte-identity tests**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~GraphQlByteIdentityTests`
Expected: PASS — both `PrDetailGraphQLQuery_is_byte_identical` and `TimelineQuery_is_byte_identical` green. If either fails, the composition drifted (most likely the trailing space after `endCursor}` in the PR-detail copy, or a missing/extra brace) — fix the composition until byte-equal.

- [ ] **Step 4: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs tests/PRism.GitHub.Tests/GraphQlByteIdentityTests.cs
git commit -m "refactor(#320): extract timeline GraphQL fragment (byte-identical)"
```

---

## Task 5: Migrate `GitHubReviewService.cs` call sites

This is the largest file. Apply the transformations below; each is behavior-preserving
(except the intended version-header addition and the GHES Link fix). Read each method first.

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.cs`

- [ ] **Step 1: `SendGitHubAsync` delegates to `GitHubHttp.SendAsync`**

The instance helper `SendGitHubAsync` (:752-764) currently reads the token and applies
headers. Reduce it to a thin wrapper that resolves the token and delegates (so the dozen
internal callers — `FetchPullJsonAsync`, `FetchPullMetaAsync`, `FetchPagedCountAsync`,
`PaginatePullsFilesAsync`, `FetchCompareFilesAsync`, the comment partials — need no change):

```csharp
private async Task<HttpResponseMessage> SendGitHubAsync(HttpClient http, HttpMethod method, string url, CancellationToken ct, HttpContent? content = null)
{
    var token = await _readToken().ConfigureAwait(false);
    return await GitHubHttp.SendAsync(http, method, url, token, ct, content).ConfigureAwait(false);
}
```

- [ ] **Step 2: `ValidateCredentialsAsync` and `SearchHasResultsAsync` use `ApplyHeaders`**

These two set `req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true)` conditionally,
so they keep their own request but single-source headers. For `ValidateCredentialsAsync`
(:77-86) replace the three inline header lines with:

```csharp
    using var http = _httpFactory.CreateClient("github");
    using var req = new HttpRequestMessage(HttpMethod.Get, "user");
    GitHubHttp.ApplyHeaders(req, http, token);
    if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);
```

For `SearchHasResultsAsync` (:218-223) the same pattern (token is already a parameter here):

```csharp
    using var http = _httpFactory.CreateClient("github");
    using var req = new HttpRequestMessage(HttpMethod.Get, url);
    GitHubHttp.ApplyHeaders(req, http, token);
    if (skipCredentialHealth) req.Options.Set(GitHubAuthHealthHandler.SkipHealthKey, true);
```

(Both now also send `X-GitHub-Api-Version` — the intended AC#2 drift fix.)

- [ ] **Step 3: `GetFileContentAsync` and `GetCommitAsync` route through `GitHubHttp.SendAsync`**

`GetFileContentAsync` (:412-423) — pass the raw Accept via the `accept` parameter:

```csharp
    var token = await _readToken().ConfigureAwait(false);
    using var http = _httpFactory.CreateClient("github");
    using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct,
        accept: "application/vnd.github.raw").ConfigureAwait(false);
```

(Delete the inline `req`/header lines and the `using var req`; keep the `MaxBytes`/`encodedPath` logic and everything after the send.)

`GetCommitAsync` (:454-462) — plain GET:

```csharp
    var token = await _readToken().ConfigureAwait(false);
    using var http = _httpFactory.CreateClient("github");
    using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
```

- [ ] **Step 4: `PostGraphQLAsync` routes through `GitHubHttp.SendAsync(apiVersion:false)` + shared error-body read**

In `PostGraphQLAsync` (:787-837) replace the inline request-build + send with:

```csharp
    var token = await _readToken().ConfigureAwait(false);
    var payload = JsonSerializer.Serialize(new { query, variables });
    using var http = _httpFactory.CreateClient("github");
    var endpoint = HostUrlResolver.GraphQlEndpoint(_host);
    using var resp = await GitHubHttp.SendAsync(
        http, HttpMethod.Post, endpoint.ToString(), token, ct,
        content: new StringContent(payload, System.Text.Encoding.UTF8, "application/json"),
        apiVersion: false).ConfigureAwait(false);
    if (!resp.IsSuccessStatusCode)
    {
        string body = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
        s_graphqlTransportFailed(_log, (int)resp.StatusCode, resp.ReasonPhrase ?? "", Truncate(body, 1024), null);
        throw new HttpRequestException(
            $"GitHub GraphQL HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(body, 512)}",
            inner: null, statusCode: resp.StatusCode);
    }
    return await resp.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
```

The endpoint is absolute and same-host as the client's `BaseAddress`, so the credential
guard passes (verified for github.com and GHES). `apiVersion:false` keeps the request
byte-identical to today (it never sent the version header).

- [ ] **Step 5: Unify the Link adapters to `GitHubLinkHeader` (absolute URLs)**

Replace `TryParseLastPage` (:555-587) body to use the shared parser, keeping the `page`
extraction local:

```csharp
private static bool TryParseLastPage(HttpResponseMessage resp, out int lastPage)
{
    lastPage = 0;
    if (!GitHubLinkHeader.TryGetRel(resp, "last", out var absolute)) return false;
    if (!Uri.TryCreate(absolute, UriKind.Absolute, out var u)) return false;
    foreach (var kv in u.Query.TrimStart('?').Split('&'))
    {
        var eq = kv.IndexOf('=', StringComparison.Ordinal);
        if (eq <= 0) continue;
        if (string.Equals(kv[..eq], "page", StringComparison.Ordinal) &&
            int.TryParse(kv[(eq + 1)..], System.Globalization.CultureInfo.InvariantCulture, out var n))
        {
            lastPage = n;
            return true;
        }
    }
    return false;
}
```

Delete `ExtractNextLink` (:719-740) entirely. In `PaginatePullsFilesAsync` (:637) replace
`var nextUrl = ExtractNextLink(resp);` with the absolute-URL form (the GHES fix — passing
the absolute URL avoids the `/api/v3/` double-prefix):

```csharp
            string? nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var next) ? next : null;
```

`url = nextUrl;` then feeds the absolute URL to `SendGitHubAsync` on the next loop —
`new HttpRequestMessage(method, absoluteUrl)` uses it directly (wire-identical on github.com).

- [ ] **Step 6: Extract `ReadActor` (group G)**

Add the helper (near the other private JSON helpers):

```csharp
// #320 — (login, avatarUrl) from an `author{login avatarUrl}` node; ("", null) when absent.
private static (string Login, string? AvatarUrl) ReadActor(JsonElement node)
{
    if (!node.TryGetProperty("author", out var a) || a.ValueKind != JsonValueKind.Object)
        return ("", null);
    var login = a.TryGetProperty("login", out var l) && l.ValueKind == JsonValueKind.String
        ? l.GetString() ?? "" : "";
    var avatar = a.TryGetProperty("avatarUrl", out var av) && av.ValueKind == JsonValueKind.String
        ? av.GetString() : null;
    return (login, avatar);
}
```

Then replace the three inline extractions (around :1018, :1079, :1116 — the `AvatarUrl()`
local function and the two `ParseIssueComments` author/avatar dances). **Read each site
first**: the three differ slightly (one only reads avatar; two read login+avatar from a node
already bound to the `author` property). Adapt each call to `ReadActor(<the node holding
author>)` and destructure. Where a site only needs the avatar, use `ReadActor(node).AvatarUrl`.
If a site's `author` element is already unwrapped differently, keep its current behavior —
do not force a site whose shape doesn't match into the helper; the goal is the 3 identical
ones collapse, not behavior change. Verify the existing `GetPrDetailAsync` / comment tests stay green.

- [ ] **Step 7: `ConcurrencyCap` → `GitHubHttp.ConcurrencyCap`**

In `GetTimelineAsync` (:391) delete `const int ConcurrencyCap = 8;` and replace its use with
`GitHubHttp.ConcurrencyCap`.

- [ ] **Step 8: Build + run the full GitHub test suite**

Run: `dotnet test tests/PRism.GitHub.Tests`
Expected: PASS, including the Task 3/4 byte-identity pins. Zero warnings (warnings are errors).

- [ ] **Step 9: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.cs
git commit -m "refactor(#320): route GitHubReviewService through GitHubHttp/GitHubLinkHeader"
```

---

## Task 6: Migrate the comment-POST partials (error-body read)

**Files:**
- Modify: `PRism.GitHub/GitHubReviewService.ReviewComments.cs` (:34-44)
- Modify: `PRism.GitHub/GitHubReviewService.IssueComments.cs` (:41-65)

- [ ] **Step 1: Replace the inline error-body read in both**

In `CreateReviewCommentAsync` (ReviewComments.cs) replace the `if (!resp.IsSuccessStatusCode){…}`
block's body with:

```csharp
        if (!resp.IsSuccessStatusCode)
        {
            var errorBody = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            throw new HttpRequestException(
                $"GitHub review comment POST HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(errorBody, 512)}",
                inner: null, statusCode: resp.StatusCode);
        }
```

In `CreateIssueCommentAsync` (IssueComments.cs) the same, preserving its exact message
(`GitHub issue comment POST HTTP …`):

```csharp
        if (!resp.IsSuccessStatusCode)
        {
            var errorBody = await GitHubHttp.ReadErrorBodyBestEffortAsync(resp, ct).ConfigureAwait(false);
            throw new HttpRequestException(
                $"GitHub issue comment POST HTTP {(int)resp.StatusCode} {resp.ReasonPhrase}: {Truncate(errorBody, 512)}",
                inner: null, statusCode: resp.StatusCode);
        }
```

**Do NOT touch** the success-path `id`/`created_at` parse in either file (spec §4.4 — the
divergent `missing 'id'.` vs `missing 'id' field.` messages stay inline). The `#pragma
warning disable CA1031` lines and the inner try/catch are deleted (now inside `GitHubHttp`).
Drop the now-unused `using System.Net;` only if nothing else in the file needs it (the
`HttpStatusCode.OK` in the success-path throw still does — keep it).

- [ ] **Step 2: Run the comment-endpoint tests**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~Comment`
Expected: PASS (the error-path and success-path behavior is unchanged). Also run the Web
comment-endpoint tests in Task 9's full sweep.

- [ ] **Step 3: Commit**

```bash
git add PRism.GitHub/GitHubReviewService.ReviewComments.cs PRism.GitHub/GitHubReviewService.IssueComments.cs
git commit -m "refactor(#320): share error-body read in comment POST partials"
```

---

## Task 7: Migrate the Inbox readers

**Files:**
- Modify: `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`
- Modify: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Modify: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`
- Modify: `PRism.GitHub/Inbox/GitHubSectionQueryRunner.cs`

Transformation recipe per file (read each first):
1. Replace inline header construction (`req.Headers.UserAgent.ParseAdd("PRism/0.1")` + `Accept` + `Authorization`) with a `GitHubHttp.SendAsync(http, method, url, token, ct)` call, or `GitHubHttp.ApplyHeaders(req, http, token)` where the caller needs its own request object.
2. Replace each 429 block with `GitHubHttp.ThrowIfRateLimited(resp[, subject])` — pass `subject: " Search API"` ONLY in `GitHubSectionQueryRunner` (it currently says "GitHub Search API rate-limited"); the others pass nothing.
3. Delete the per-class `const int ConcurrencyCap = 8;` and use `GitHubHttp.ConcurrencyCap`.
4. These readers all now send `X-GitHub-Api-Version` (intended).

- [ ] **Step 1: `GitHubPrEnricher`**

`FetchAsync` (:48-64): replace the `using var req = …` + 3 header lines + `http.SendAsync` with:

```csharp
        using var http = _httpFactory.CreateClient("github");
        using var resp = await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
        if (resp.StatusCode == HttpStatusCode.NotFound) return null;
        GitHubHttp.ThrowIfRateLimited(resp);
        resp.EnsureSuccessStatusCode();
```

Delete `const int ConcurrencyCap = 8;` (:12) and use `new SemaphoreSlim(GitHubHttp.ConcurrencyCap)` (:29). Remove the now-unused `using System.Net.Http.Headers;` if nothing else needs it.

- [ ] **Step 2: `GitHubCiFailingDetector`**

Replace `SendCoreAsync` (:315-326) — it builds the request and applies headers — with a single
delegation, collapsing the two `SendAsync` overloads to call `GitHubHttp.SendAsync` with the
URL as a string. Replace the whole private send region (:306-326) with:

```csharp
    private async Task<HttpResponseMessage> SendAsync(string url, string? token, CancellationToken ct)
    {
        using var http = _httpFactory.CreateClient("github");
        return await GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct).ConfigureAwait(false);
    }
```

`FetchChecksAsync` loops over `Uri? nextUri`; switch it to `string? nextUrl`:
- `:127` `Uri? nextUri = null;` → `string? nextUrl = null;`
- `:132-134` the `nextUri is null ? SendAsync(initialUrl,…) : SendAsync(nextUri,…)` → `await SendAsync(nextUrl ?? initialUrl, token, ct)`.
- `:206` `nextUri = TryGetNextLink(resp);` → `nextUrl = GitHubLinkHeader.TryGetRel(resp, "next", out var n) ? n : null;`
- `:207` `if (nextUri is null) break;` → `if (nextUrl is null) break;`

Delete `TryGetNextLink` (:224-252) entirely. Replace the two 429 blocks (:136-139, :259-262) with `GitHubHttp.ThrowIfRateLimited(resp);`. Delete `const int ConcurrencyCap = 8;` (:11) and use `new SemaphoreSlim(GitHubHttp.ConcurrencyCap)` (:28). Drop the now-unused `using System.Net.Http.Headers;`.

> The CI pagination now passes the absolute Link URL (string) straight to `GitHubHttp.SendAsync` — same as the prior `Uri` overload, which also handed the absolute URL through unchanged. Behavior-identical.

- [ ] **Step 3: `GitHubAwaitingAuthorFilter` and `GitHubSectionQueryRunner`**

Read each. Apply the recipe:
- `GitHubAwaitingAuthorFilter` (:61-71): inline headers → `GitHubHttp.SendAsync(...)`; 429 (:68-71) → `GitHubHttp.ThrowIfRateLimited(resp)`; `ConcurrencyCap` (:12) → `GitHubHttp.ConcurrencyCap`.
- `GitHubSectionQueryRunner` (:106-122): it resolves the token once upstream and shares it — pass that resolved token into `GitHubHttp.SendAsync(...)` (do NOT introduce a per-request `_readToken()` call). 429 (:116-122) → `GitHubHttp.ThrowIfRateLimited(resp, " Search API")` (preserve the Search-API qualifier). It also parses Link for pagination if present — if it has its own next-link logic, migrate it to `GitHubLinkHeader.TryGetRel(resp, "next", out var n)`; if it does not paginate, leave that alone.

- [ ] **Step 4: Run the Inbox tests**

Run: `dotnet test tests/PRism.GitHub.Tests --filter FullyQualifiedName~Inbox`
Expected: PASS. Pay attention to the CI-detector tests (`#264`/`#286`/`#355` cases) and the
429/degradation tests — they are the behavior backstop here.

- [ ] **Step 5: Commit**

```bash
git add PRism.GitHub/Inbox/
git commit -m "refactor(#320): route Inbox readers through GitHubHttp (headers, 429, Link, cap)"
```

---

## Task 8: Migrate the Activity readers + Feedback submitter

**Files:**
- Modify: `PRism.GitHub/Activity/GitHubReceivedEventsReader.cs`, `GitHubNotificationsReader.cs`, `GitHubWatchedReposReader.cs`, `GitHubPrTimelineReader.cs`
- Modify: `PRism.GitHub/Feedback/GitHubFeedbackSubmitter.cs`

- [ ] **Step 1: Activity readers**

Three of the four — `GitHubReceivedEventsReader`, `GitHubNotificationsReader`,
`GitHubWatchedReposReader` — are plain **GET REST** calls. For each (read first), replace the
inline `req` + 3 header lines + `http.SendAsync` with
`GitHubHttp.SendAsync(http, HttpMethod.Get, url, token, ct)`. They currently omit
`X-GitHub-Api-Version`; routing through the helper adds it (intended AC#2). If any reader
paginates via Link, migrate it to `GitHubLinkHeader.TryGetRel(resp, "next", out var n)` and
pass the absolute `n` string to the next `SendAsync`. Preserve each reader's token cadence
(resolve where it resolves today, pass the resolved value).

> **`GitHubPrTimelineReader` is the exception — it is a GraphQL POST, not a GET.** It posts a
> `StringContent` payload to the absolute `HostUrlResolver.GraphQlEndpoint(...)` and
> deliberately omits the version header. Route it like `PostGraphQLAsync` (Task 5 Step 4):
> `GitHubHttp.SendAsync(http, HttpMethod.Post, endpoint.ToString(), token, ct, content: new StringContent(payload, System.Text.Encoding.UTF8, "application/json"), apiVersion: false)`.
> The off-host guard passes because the GraphQL endpoint host == the client's `BaseAddress`
> host. Do NOT use the GET-REST recipe on it.

> **Do NOT add `GitHubHttp.ThrowIfRateLimited` to the Activity readers.** Unlike the Inbox
> readers (Task 7), the activity surface has no orchestrator backoff loop and intentionally
> **degrades** (not throws) on every non-success, including 429 — e.g.
> `GitHubReceivedEventsReader` returns `Degraded: true`. Keep each reader's existing
> `if (!resp.IsSuccessStatusCode) return …Degraded: true;` block exactly as-is; only the
> header construction changes.

- [ ] **Step 2: Feedback submitter**

`GitHubFeedbackSubmitter` (:63-67) uses its own `"github.com"` client (`BaseAddress =
https://api.github.com/`) and ALREADY sends `X-GitHub-Api-Version`. Replace its inline header
construction with `GitHubHttp.SendAsync(http, method, url, token, ct, content: …)` (or
`ApplyHeaders`). The same-host guard checks against THIS client's `BaseAddress` (`api.github.com`),
so it is inert. **Do not remove** the submitter's existing `IsGitHubCom` / host-allowlist guard —
that is its own policy (spec §5 leaves the egress allowlist out of scope). Confirm the feedback
endpoint tests stay green.

- [ ] **Step 3: Run Activity + Feedback tests**

Run: `dotnet test tests/PRism.GitHub.Tests --filter "FullyQualifiedName~Activity|FullyQualifiedName~Feedback"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add PRism.GitHub/Activity/ PRism.GitHub/Feedback/
git commit -m "refactor(#320): route Activity readers + Feedback submitter through GitHubHttp"
```

---

## Task 9: Final verification (AC sweep)

**Files:** none (verification + cleanup).

- [ ] **Step 1: AC#1 — UA literal single-sourced**

Run (PowerShell): `Get-ChildItem PRism.GitHub -Recurse -Filter *.cs | Select-String -Pattern '"PRism/0.1"' | Measure-Object | % Count`
Expected: **1** (only `GitHubHttp.UserAgent`). If > 1, a call site still inlines the literal — replace it with the const / route it through `GitHubHttp`.

- [ ] **Step 2: AC#3 — satellite copies deleted**

Confirm these symbols no longer exist in production code (search each; expect 0 hits outside `GitHubHttp`/`GitHubLinkHeader`):
- `ExtractNextLink`, `TryGetNextLink` (replaced by `GitHubLinkHeader.TryGetRel`)
- inline `RateLimitExceededException` throws (all via `GitHubHttp.ThrowIfRateLimited`)
- per-class `const int ConcurrencyCap`
- the `#pragma warning disable CA1031` error-body blocks in `PostGraphQLAsync` / comment partials (now only in `GitHubHttp.ReadErrorBodyBestEffortAsync`)

Run: `Get-ChildItem PRism.GitHub -Recurse -Filter *.cs | Select-String -Pattern 'ExtractNextLink|TryGetNextLink|const int ConcurrencyCap'`
Expected: no matches.

- [ ] **Step 2b: AC#2 / AC#4 — covered by earlier tasks**

No new command — confirm the coverage exists: **AC#2** (all REST calls send
`X-GitHub-Api-Version`) is pinned by `GitHubHttpTests.SendAsync_attaches_standard_headers_and_version`
(Task 1) and exercised by the migrated readers' suites (Tasks 5/7/8) in Step 3's full run.
**AC#4** (GraphQL byte-identical) is pinned by `GraphQlByteIdentityTests`
(`PrDetailGraphQLQuery_is_byte_identical`, `TimelineQuery_is_byte_identical`) plus the
submit-path transport test (Task 3) and integration test 7g. Both go green in Step 3.

- [ ] **Step 3: AC#5 — full Release suite, zero warnings**

Run: `dotnet test --configuration Release` (from repo root — runs Core / Web / GitHub / Integration). Timeout ≥ 300000 ms; foreground; do not run any other build/test concurrently.
Expected: PASS, **zero build warnings** (warnings are errors). Watch for unused-`using` errors (CS8019/IDE0005 are Hidden and won't fail the build, but remove obvious dead `using`s left by the migrations to keep the diff clean).

- [ ] **Step 4: Lint/format (frontend untouched, but run the repo pre-push backend checks)**

Backend-only change — no frontend build needed. Run the repo's documented pre-push backend
checklist (`.ai/docs/development-process.md`). Confirm `dotnet build --configuration Release`
is warning-free.

- [ ] **Step 5: Commit any cleanup**

```bash
git add -A
git commit -m "chore(#320): remove dead usings after transport consolidation"
```

---

## Self-review (run before handing off to execution)

**Spec coverage:**
- §4.1 `GitHubHttp` (consts, `SendAsync`, `ApplyHeaders`, host guard, `ConcurrencyCap`) → Task 1, applied in 5/7/8.
- §4.2 `GitHubLinkHeader` + unify-to-absolute + GHES fix → Task 2, applied in 5 (Step 5) / 7 (Step 2).
- §4.3 `ThrowIfRateLimited` + `subject` → Task 1, applied in 7.
- §4.4 `ReadErrorBodyBestEffortAsync` + `apiVersion:false` GraphQL + `ParseCreatedEntity` NOT extracted → Task 1, applied in 5 (Step 4) / 6.
- §4.5 `ReadActor` → Task 5 (Step 6).
- §4.6 timeline fragment byte-identical → Tasks 3–4.
- §4.7 `ConcurrencyCap` on `GitHubHttp`, no `GitHubLimits` class → Task 1 + 5/7.
- §7 submit-path byte-identity pin → Task 3 (Step 1, submit-path test).
- §8 test plan → Tasks 1–4 unit/char tests, 5–8 suite runs, 9 AC sweep.
- Deferred (E, page sizes, Submit envelope) → not present in any task. ✓

**Type/signature consistency:** `GitHubHttp.SendAsync(HttpClient, HttpMethod, string, string?, CancellationToken, HttpContent?, string?, bool)`, `ApplyHeaders(HttpRequestMessage, HttpClient, string?, string?, bool)`, `ThrowIfRateLimited(HttpResponseMessage, string)`, `ReadErrorBodyBestEffortAsync(HttpResponseMessage, CancellationToken)`, `GitHubLinkHeader.TryGetRel(HttpResponseMessage, string, out string)` — used consistently across Tasks 5–8. ✓

**Placeholder scan:** the only deferred-detail item is Task 5 Step 6 (per-site `ReadActor` adaptation) and Task 7/8 (read-then-apply-recipe) — these require reading the exact current site because the three author sites and the small readers were not all quoted here; the transformation pattern and the per-site gotchas (token cadence, Search-API 429 subject, raw Accept) are specified. Acceptable for subagent-driven execution.

**Behavior-preservation risks pinned by tests:** GraphQL bytes (Task 3/4), header set incl. version + apiVersion:false (Task 1), Link parity incl. GHES (Tasks 2/5), 429 message (Task 1), submit-path transport (Task 3). The existing endpoint/integration suites are the backstop for the call-site rewrites.
