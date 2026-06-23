# Inbox hydration + reviews: batched GraphQL (#532) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the inbox's per-PR REST hydration fan-out (`GitHubPrEnricher`) and per-PR awaiting-author review walk (`GitHubAwaitingAuthorFilter`) with one aliased-batch GraphQL reader, cutting `4 + N + N` REST round-trips per refresh to `4 + ceil(stale/100)` GraphQL batches.

**Architecture:** A new `IPrBatchReader` (impl `GitHubPrBatchReader`) issues one aliased GraphQL query per ≤100 PRs through the shared `GitHubGraphQL.PostAsync` transport, returning a `IReadOnlyDictionary<PrReference, BatchPrData>` of hydration fields + the viewer's last-review SHA. It caches per `(PrReference, UpdatedAt)` so a quiescent inbox issues zero batches. `InboxRefreshOrchestrator` calls it once per refresh, maps the data onto each `RawPrInboxItem`, and applies a pure awaiting-author predicate. CI detection stays REST (no GraphQL equivalent).

**Tech Stack:** C# / .NET 10, `System.Text.Json` (`JsonDocument`), xUnit + FluentAssertions, the existing `FakeHttpClientFactory`/`FakeHttpMessageHandler` test doubles.

## Global Constraints

- **Spec:** `docs/specs/2026-06-23-532-inbox-batch-graphql-design.md`. Epic #598 (Slice A — anchor). Tier T3, hands-off (backend-only).
- **Zero frontend / DTO / persisted-schema change.** `RawPrInboxItem`, `PrInboxItem`, `state.json` are untouched. Do not modify any `frontend/` file.
- **No REST fallback.** Maintaining a parallel REST path defeats the consolidation.
- **CI detection stays REST** (`GitHubCiFailingDetector`) — out of scope, untouched.
- **PAT-egress guard intact:** every GraphQL POST goes through `GitHubGraphQL.PostAsync` (which routes via `GitHubHttp.SendAsync` → `ApplyHeaders` same-host guard). Never hand-roll the HTTP request.
- **Rate-limit error model (reader-owned):** HTTP 429 **or** a 200 body whose `errors[].type == "RATE_LIMITED"` → throw `RateLimitExceededException(message, retryAfter: null)`. Any other non-2xx / transport failure → let it propagate (aborts the tick). Per-alias null / non-rate-limit error → drop that ref (logged), do not throw.
- **Awaiting-author parity:** the last-review SHA selection takes the viewer's review with the max `submittedAt` among reviews with a non-null `submittedAt` AND a non-empty `commit.oid`, with **no `state` filter** (do NOT reuse `GitHubPrParser.ParseViewerReview`, which excludes DISMISSED/PENDING).
- **`pushedAt` parity:** guard BOTH `headRepository` (present + object-kind) AND the `pushedAt` leaf (String-kind) before `GetDateTimeOffset()`; fall back to `UpdatedAt` otherwise.
- **Build/test one at a time, foreground, ≥300000ms timeout.** Full build: `dotnet build PRism.sln`. Targeted test: `dotnet test --filter "<expr>"`. Full pre-push gate per `.ai/docs/development-process.md`.
- **Commit message footer (every commit):**
  ```
  Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01DvJu7UHsKbViiQUmaoPEHf
  ```

### Deviations from the spec (decided here, documented per repo rule)

1. **Interface named `IPrBatchReader`, not `IGitHubPrBatchReader`.** Core's collaborator interfaces are provider-agnostic (`IPrEnricher`, `ISectionQueryRunner`, `ICiFailingDetector`, `IPrTimelineReader`). The impl is `GitHubPrBatchReader`. Mechanical naming alignment.
2. **`ReadAsync` takes `IReadOnlyList<RawPrInboxItem>`, not `IReadOnlyList<PrReference>`.** *Substantive correction.* The cache key the spec mandates is `(PrReference, UpdatedAt)`; a bare `PrReference` list carries no `UpdatedAt`, so the reader could not compute the key. `RawPrInboxItem` carries both and matches the existing `IPrEnricher`/`IAwaitingAuthorFilter` input convention.
3. **The `reviews` selection omits `state`.** The spec selected `state` but marked it "intentionally unused on the parity path." YAGNI — the parity path never reads it, and reviving the prior-review marker (#527) is an explicit non-goal.

---

### Task 1: Core contract — `IPrBatchReader`, `BatchPrData`, awaiting-author predicate

**Files:**
- Create: `PRism.Core/Inbox/IPrBatchReader.cs`
- Create: `PRism.Core/Inbox/AwaitingAuthorRule.cs`
- Test: `tests/PRism.Core.Tests/Inbox/AwaitingAuthorRuleTests.cs`

**Interfaces:**
- Consumes: `PRism.Core.Contracts.PrReference`, `PRism.Core.Inbox.RawPrInboxItem` (existing).
- Produces:
  - `IPrBatchReader.ReadAsync(IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct) → Task<IReadOnlyDictionary<PrReference, BatchPrData>>`
  - `record BatchPrData(string HeadSha, int Additions, int Deletions, int CommitCount, int ChangedFiles, DateTimeOffset PushedAt, DateTimeOffset? MergedAt, DateTimeOffset? ClosedAt, string? ViewerLastReviewSha)`
  - `AwaitingAuthorRule.IsAwaitingAuthor(string? viewerLastReviewSha, string headSha) → bool`

- [ ] **Step 1: Write the failing predicate test**

`tests/PRism.Core.Tests/Inbox/AwaitingAuthorRuleTests.cs`:

```csharp
using FluentAssertions;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class AwaitingAuthorRuleTests
{
    [Fact]
    public void Awaiting_when_last_review_sha_differs_from_head()
        => AwaitingAuthorRule.IsAwaitingAuthor("oldsha", "newsha").Should().BeTrue();

    [Fact]
    public void Not_awaiting_when_last_review_sha_equals_head()
        => AwaitingAuthorRule.IsAwaitingAuthor("samesha", "samesha").Should().BeFalse();

    [Fact]
    public void Not_awaiting_when_no_comparable_review()
        => AwaitingAuthorRule.IsAwaitingAuthor(null, "newsha").Should().BeFalse();
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `dotnet test --filter "FullyQualifiedName~AwaitingAuthorRuleTests"`
Expected: FAIL — `AwaitingAuthorRule` does not exist (compile error).

- [ ] **Step 3: Create the contract types**

`PRism.Core/Inbox/IPrBatchReader.cs`:

```csharp
using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

/// <summary>
/// One aliased-batch GraphQL read of hydration fields + the viewer's last-review SHA for
/// every inbox PR, replacing the per-PR REST hydration and awaiting-author review walk.
/// Caches per (Reference, UpdatedAt); returns only refs that resolved — unresolved refs
/// (PAT can't see the repo, deleted PR, malformed alias) are simply absent. Throws
/// <see cref="RateLimitExceededException"/> on a GitHub rate limit; any other transport
/// failure propagates and aborts the refresh tick.
/// </summary>
public interface IPrBatchReader
{
    Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct);
}

/// <summary>Hydration fields from the GraphQL pullRequest node, plus the viewer's
/// last-review head SHA (computed at parse time from <c>reviews(last:100)</c>).</summary>
public sealed record BatchPrData(
    string HeadSha,
    int Additions,
    int Deletions,
    int CommitCount,
    int ChangedFiles,
    DateTimeOffset PushedAt,
    DateTimeOffset? MergedAt,
    DateTimeOffset? ClosedAt,
    string? ViewerLastReviewSha);
```

`PRism.Core/Inbox/AwaitingAuthorRule.cs`:

```csharp
namespace PRism.Core.Inbox;

/// <summary>
/// The awaiting-author inclusion predicate, extracted as a pure function so it is unit-testable
/// independent of the GraphQL reader. A PR is "awaiting author" (from the viewer's seat) when the
/// viewer has reviewed at an earlier head than the PR's current head. A null last-review SHA (the
/// viewer never left a review with a comparable commit) means "not awaiting".
/// </summary>
public static class AwaitingAuthorRule
{
    public static bool IsAwaitingAuthor(string? viewerLastReviewSha, string headSha)
        => viewerLastReviewSha is { } sha && sha != headSha;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `dotnet test --filter "FullyQualifiedName~AwaitingAuthorRuleTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Inbox/IPrBatchReader.cs PRism.Core/Inbox/AwaitingAuthorRule.cs tests/PRism.Core.Tests/Inbox/AwaitingAuthorRuleTests.cs
git commit -m "feat(inbox): add IPrBatchReader contract + awaiting-author predicate (#532)"
```

---

### Task 2: `GitHubPrBatchReader` implementation + unit tests

**Files:**
- Create: `PRism.GitHub/Inbox/GitHubPrBatchReader.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (add `IPrBatchReader` registration — additive; old enricher/awaiting registrations stay until Task 5)
- Test: `tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs`

**Interfaces:**
- Consumes: `IPrBatchReader`, `BatchPrData` (Task 1); `GitHubGraphQL.PostAsync(HttpClient, string?, string host, ILogger, string query, object variables, CancellationToken) → Task<string>` (throws `HttpRequestException` with `StatusCode` on non-2xx); `InboxCacheEviction.PruneAbsent<TKey2,TValue>(ConcurrentDictionary<(PrReference,TKey2),TValue>, IReadOnlyCollection<PrReference>)`; `RateLimitExceededException(string, TimeSpan?)`.
- Produces: `GitHubPrBatchReader : IPrBatchReader` with ctor `(IHttpClientFactory httpFactory, Func<Task<string?>> readToken, Func<string> readHost, ILogger<GitHubPrBatchReader>? log = null)`.

- [ ] **Step 1: Write the failing unit tests**

`tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs`:

```csharp
using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubPrBatchReaderTests
{
    private static readonly DateTimeOffset T0 = new(2026, 6, 23, 12, 0, 0, TimeSpan.Zero);

    private static RawPrInboxItem Raw(int n, string owner = "acme", string repo = "api", DateTimeOffset? updated = null)
        => new(new PrReference(owner, repo, n), $"PR #{n}", "author", $"{owner}/{repo}",
               updated ?? T0, T0, 0, 0, 0, "", 1, 0);

    // A reader whose every GraphQL POST returns the same (code, body). Records request count.
    private static (GitHubPrBatchReader Reader, Func<int> Calls) MakeReader(
        HttpStatusCode code, string json, string viewerHost = "https://github.com")
    {
        var calls = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            calls++;
            var resp = new HttpResponseMessage(code);
            resp.Content = new System.Net.Http.StringContent(json, System.Text.Encoding.UTF8, "application/json");
            return resp;
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => viewerHost);
        return (reader, () => calls);
    }

    // Build a one-alias data response (a0) for a fully-hydrated PR.
    private static string OneAliasOk(
        string headSha = "head1", int additions = 5, int deletions = 2, int changed = 3,
        int commits = 4, string pushedAt = "2026-06-23T11:00:00Z",
        string? mergedAt = null, string? closedAt = null, string reviewsJson = "[]")
    {
        string Q(string? s) => s is null ? "null" : $"\"{s}\"";
        return $$"""
        {"data":{"a0":{"pullRequest":{
          "headRefOid":"{{headSha}}","additions":{{additions}},"deletions":{{deletions}},
          "changedFiles":{{changed}},"commits":{"totalCount":{{commits}}},
          "mergedAt":{{Q(mergedAt)}},"closedAt":{{Q(closedAt)}},
          "headRepository":{"pushedAt":"{{pushedAt}}"},
          "reviews":{"nodes":{{reviewsJson}}}
        }}},"rateLimit":{"cost":1,"remaining":4999}}}
        """;
    }

    // Two fully-hydrated aliases (a0→head h7, a1→head h8), no reviews.
    private static string TwoAliasOk()
        => """
        {"data":{
          "a0":{"pullRequest":{"headRefOid":"h7","additions":0,"deletions":0,"changedFiles":0,
            "commits":{"totalCount":1},"mergedAt":null,"closedAt":null,
            "headRepository":{"pushedAt":"2026-06-23T10:00:00Z"},"reviews":{"nodes":[]}}},
          "a1":{"pullRequest":{"headRefOid":"h8","additions":0,"deletions":0,"changedFiles":0,
            "commits":{"totalCount":1},"mergedAt":null,"closedAt":null,
            "headRepository":{"pushedAt":"2026-06-23T10:00:00Z"},"reviews":{"nodes":[]}}}},
        "rateLimit":{"cost":1,"remaining":1}}
        """;

    // A reader wired to a capturing logger so tests can assert log emissions (e.g. truncation).
    private static (GitHubPrBatchReader Reader, CapturingLogger<GitHubPrBatchReader> Log) MakeReaderWithLog(
        HttpStatusCode code, string json)
    {
        var log = new CapturingLogger<GitHubPrBatchReader>();
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Returns(code, json), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com", log);
        return (reader, log);
    }

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter) => Messages.Add(formatter(state, exception));
        private sealed class NullScope : IDisposable
        { public static readonly NullScope Instance = new(); public void Dispose() { } }
    }

    [Fact] // Test 1 — query construction
    public async Task Builds_aliased_query_with_owner_name_number_and_ratelimit()
    {
        string? sent = null;
        var handler = new FakeHttpMessageHandler(req =>
        {
            sent = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new System.Net.Http.StringContent("{\"data\":{}}", System.Text.Encoding.UTF8, "application/json") };
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.ReadAsync(new[] { Raw(7, "acme", "api") }, "viewer", CancellationToken.None);

        sent.Should().Contain("a0: repository(owner:\\\"acme\\\", name:\\\"api\\\")");
        sent.Should().Contain("pullRequest(number:7)");
        sent.Should().Contain("reviews(last:100)");
        sent.Should().Contain("rateLimit");
        sent.Should().NotContain("viewer{");
    }

    [Fact] // Test 2 — alias parsing (full hydration)
    public async Task Parses_hydration_fields()
    {
        var (reader, _) = MakeReader(HttpStatusCode.OK,
            OneAliasOk(headSha: "abc", additions: 11, deletions: 4, changed: 6, commits: 9,
                       pushedAt: "2026-06-23T10:30:00Z", mergedAt: "2026-06-23T10:45:00Z"));
        var r = await reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None);
        var d = r[new PrReference("acme", "api", 7)];
        d.HeadSha.Should().Be("abc");
        d.Additions.Should().Be(11);
        d.Deletions.Should().Be(4);
        d.ChangedFiles.Should().Be(6);
        d.CommitCount.Should().Be(9);
        d.PushedAt.Should().Be(new DateTimeOffset(2026, 6, 23, 10, 30, 0, TimeSpan.Zero));
        d.MergedAt.Should().Be(new DateTimeOffset(2026, 6, 23, 10, 45, 0, TimeSpan.Zero));
        d.ClosedAt.Should().BeNull();
    }

    [Fact] // Test 5a — awaiting-author parity: DISMISSED included, max submittedAt wins
    public async Task ViewerLastReviewSha_takes_max_submittedAt_no_state_filter()
    {
        const string reviews = """
        [{"author":{"login":"viewer"},"submittedAt":"2026-06-20T00:00:00Z","commit":{"oid":"old"}},
         {"author":{"login":"viewer"},"submittedAt":"2026-06-22T00:00:00Z","commit":{"oid":"newer"}},
         {"author":{"login":"other"},"submittedAt":"2026-06-23T00:00:00Z","commit":{"oid":"notmine"}}]
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, OneAliasOk(reviewsJson: reviews));
        var r = await reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None);
        r[new PrReference("acme", "api", 7)].ViewerLastReviewSha.Should().Be("newer");
    }

    [Fact] // Test 5b — PENDING (null submittedAt) and empty oid skipped
    public async Task ViewerLastReviewSha_skips_pending_and_empty_oid()
    {
        const string reviews = """
        [{"author":{"login":"viewer"},"submittedAt":null,"commit":{"oid":"draft"}},
         {"author":{"login":"viewer"},"submittedAt":"2026-06-22T00:00:00Z","commit":{"oid":""}},
         {"author":{"login":"viewer"},"submittedAt":"2026-06-21T00:00:00Z","commit":{"oid":"real"}}]
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, OneAliasOk(reviewsJson: reviews));
        var r = await reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None);
        r[new PrReference("acme", "api", 7)].ViewerLastReviewSha.Should().Be("real");
    }

    [Fact] // Test 5c — exactly 100 review nodes → truncation log (reviews(last:100) has no pageInfo)
    public async Task Logs_when_reviews_page_is_full()
    {
        const string node = "{\"author\":{\"login\":\"other\"},\"submittedAt\":\"2026-06-20T00:00:00Z\",\"commit\":{\"oid\":\"x\"}}";
        var nodes = "[" + string.Join(",", Enumerable.Repeat(node, 100)) + "]";
        var (reader, log) = MakeReaderWithLog(HttpStatusCode.OK, OneAliasOk(reviewsJson: nodes));
        await reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None);
        log.Messages.Should().Contain(m => m.Contains("full page"));
    }

    [Fact] // Test 6a — pushedAt: headRepository null → UpdatedAt fallback
    public async Task PushedAt_falls_back_when_headRepository_null()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{
          "headRefOid":"h","additions":0,"deletions":0,"changedFiles":0,"commits":{"totalCount":1},
          "mergedAt":null,"closedAt":null,"headRepository":null,"reviews":{"nodes":[]}
        }}},"rateLimit":{"cost":1,"remaining":4999}}}
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, json);
        var r = await reader.ReadAsync(new[] { Raw(7, updated: T0) }, "viewer", CancellationToken.None);
        r[new PrReference("acme", "api", 7)].PushedAt.Should().Be(T0);
    }

    [Fact] // Test 6b — pushedAt: present headRepository but null scalar → UpdatedAt fallback (ref survives)
    public async Task PushedAt_falls_back_when_scalar_null_and_ref_survives()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{
          "headRefOid":"h","additions":0,"deletions":0,"changedFiles":0,"commits":{"totalCount":1},
          "mergedAt":null,"closedAt":null,"headRepository":{"pushedAt":null},"reviews":{"nodes":[]}
        }}},"rateLimit":{"cost":1,"remaining":4999}}}
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, json);
        var r = await reader.ReadAsync(new[] { Raw(7, updated: T0) }, "viewer", CancellationToken.None);
        r.Should().ContainKey(new PrReference("acme", "api", 7));
        r[new PrReference("acme", "api", 7)].PushedAt.Should().Be(T0);
    }

    [Fact] // Test 3 — >100 refs split into multiple queries, merged
    public async Task Splits_over_100_refs_into_multiple_batches()
    {
        // Responder echoes back exactly the aliases present in the request (a0..aK-1).
        var batchCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            batchCount++;
            var q = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            var aliases = System.Text.RegularExpressions.Regex.Matches(q, @"a(\d+): repository")
                .Select(m => $"\"a{m.Groups[1].Value}\":{{\"pullRequest\":{{\"headRefOid\":\"h\",\"additions\":0,\"deletions\":0,\"changedFiles\":0,\"commits\":{{\"totalCount\":1}},\"mergedAt\":null,\"closedAt\":null,\"headRepository\":{{\"pushedAt\":\"2026-06-23T10:00:00Z\"}},\"reviews\":{{\"nodes\":[]}}}}}}");
            var body = "{\"data\":{" + string.Join(",", aliases) + "},\"rateLimit\":{\"cost\":1,\"remaining\":1}}}";
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        var items = Enumerable.Range(1, 150).Select(n => Raw(n)).ToList();
        var r = await reader.ReadAsync(items, "viewer", CancellationToken.None);

        batchCount.Should().Be(2);   // 100 + 50
        r.Should().HaveCount(150);
    }

    [Fact] // Test 4 — per-alias null tolerated, others present
    public async Task Drops_null_alias_keeps_others()
    {
        const string json = """
        {"data":{
          "a0":{"pullRequest":{"headRefOid":"h0","additions":0,"deletions":0,"changedFiles":0,
            "commits":{"totalCount":1},"mergedAt":null,"closedAt":null,
            "headRepository":{"pushedAt":"2026-06-23T10:00:00Z"},"reviews":{"nodes":[]}}},
          "a1":null},"rateLimit":{"cost":1,"remaining":1}}
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, json);
        var r = await reader.ReadAsync(new[] { Raw(7), Raw(8) }, "viewer", CancellationToken.None);
        r.Should().ContainSingle();
        r.Should().ContainKey(new PrReference("acme", "api", 7));
    }

    [Fact] // Test 7 — caching: unchanged UpdatedAt → no second fetch
    public async Task Caches_by_updatedAt_and_skips_unchanged()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        var items = new[] { Raw(7, updated: T0) };
        await reader.ReadAsync(items, "viewer", CancellationToken.None);
        await reader.ReadAsync(items, "viewer", CancellationToken.None);
        calls().Should().Be(1);   // second tick is a pure cache hit
    }

    [Fact] // Test 7b — changed UpdatedAt → re-fetch
    public async Task Refetches_when_updatedAt_changes()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        await reader.ReadAsync(new[] { Raw(7, updated: T0) }, "viewer", CancellationToken.None);
        await reader.ReadAsync(new[] { Raw(7, updated: T0.AddMinutes(5)) }, "viewer", CancellationToken.None);
        calls().Should().Be(2);
    }

    [Fact] // Test 7c — eviction runs even on a full-cache-hit tick (a PR that left the inbox is purged)
    public async Task Prunes_absent_ref_even_when_remaining_are_cache_hits()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, TwoAliasOk());
        var p7 = Raw(7, updated: T0);
        var p8 = Raw(8, updated: T0);
        await reader.ReadAsync(new[] { p7, p8 }, "viewer", CancellationToken.None);  // calls=1, caches 7 & 8
        await reader.ReadAsync(new[] { p8 }, "viewer", CancellationToken.None);       // full hit on 8 → no fetch; prunes 7
        calls().Should().Be(1);
        await reader.ReadAsync(new[] { p7 }, "viewer", CancellationToken.None);       // 7 was pruned → re-fetch
        calls().Should().Be(2);
    }

    [Fact] // Test 8a — HTTP 429 → RateLimitExceededException
    public async Task Http_429_throws_rate_limit()
    {
        var (reader, _) = MakeReader(HttpStatusCode.TooManyRequests, "{}");
        await Assert.ThrowsAsync<RateLimitExceededException>(
            () => reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None));
    }

    [Fact] // Test 8b — 200 body with errors[].type=RATE_LIMITED → RateLimitExceededException
    public async Task Body_rate_limited_throws_rate_limit()
    {
        const string json = """{"data":null,"errors":[{"type":"RATE_LIMITED","message":"limit"}]}""";
        var (reader, _) = MakeReader(HttpStatusCode.OK, json);
        await Assert.ThrowsAsync<RateLimitExceededException>(
            () => reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None));
    }

    [Fact] // Test 8c — non-429 transport failure propagates (aborts the tick)
    public async Task Non_rate_limit_failure_propagates()
    {
        var (reader, _) = MakeReader(HttpStatusCode.InternalServerError, "boom");
        await Assert.ThrowsAsync<HttpRequestException>(
            () => reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None));
    }

    [Fact] // Empty input → empty, no HTTP
    public async Task Empty_input_returns_empty_without_http()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        var r = await reader.ReadAsync(Array.Empty<RawPrInboxItem>(), "viewer", CancellationToken.None);
        r.Should().BeEmpty();
        calls().Should().Be(0);
    }
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `dotnet test --filter "FullyQualifiedName~GitHubPrBatchReaderTests"`
Expected: FAIL — `GitHubPrBatchReader` does not exist (compile error).

- [ ] **Step 3: Implement `GitHubPrBatchReader`**

`PRism.GitHub/Inbox/GitHubPrBatchReader.cs`:

```csharp
using System.Collections.Concurrent;
using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Batched GraphQL replacement for GitHubPrEnricher + GitHubAwaitingAuthorFilter. ONE aliased
/// query hydrates many PRs at once (head SHA, diff stats, commit count, changed files, pushedAt,
/// merged/closed timestamps) AND computes the viewer's last-review SHA from reviews(last:100).
/// Caches per (Reference, UpdatedAt) so a quiescent inbox issues zero batches. Owns its own
/// rate-limit error model (it does NOT degrade-to-empty like GitHubPrTimelineReader): a 429 or a
/// 200/RATE_LIMITED body throws RateLimitExceededException so InboxPoller backs off; any other
/// transport failure propagates and aborts the tick; a per-alias null/error drops just that ref.
/// </summary>
public sealed partial class GitHubPrBatchReader : IPrBatchReader
{
    private const int MaxBatch = 100;        // GitHub aliased-batch safety cap (mirrors GitHubPrTimelineReader)
    private const int MaxReviewNodes = 100;  // reviews(last:100) page size — a full page signals possible truncation
    private readonly IHttpClientFactory _httpFactory;
    private readonly Func<Task<string?>> _readToken;
    private readonly Func<string> _readHost;   // late-bound: GraphQL endpoint follows a live host change
    private readonly ILogger<GitHubPrBatchReader> _log;
    private readonly ConcurrentDictionary<(PrReference, DateTimeOffset), BatchPrData> _cache = new();

    public GitHubPrBatchReader(
        IHttpClientFactory httpFactory,
        Func<Task<string?>> readToken,
        Func<string> readHost,
        ILogger<GitHubPrBatchReader>? log = null)
    {
        _httpFactory = httpFactory;
        _readToken = readToken;
        _readHost = readHost;
        _log = log ?? NullLogger<GitHubPrBatchReader>.Instance;
    }

    public async Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(items);
        var result = new Dictionary<PrReference, BatchPrData>();
        if (items.Count == 0) { _cache.Clear(); return result; }

        // Partition into cache hits vs stale (key = (ref, UpdatedAt) — UpdatedAt bumps on any PR
        // activity, including a new review, so an unchanged key guarantees nothing we read changed).
        var stale = new List<RawPrInboxItem>();
        foreach (var it in items)
        {
            if (_cache.TryGetValue((it.Reference, it.UpdatedAt), out var hit))
                result[it.Reference] = hit;
            else
                stale.Add(it);
        }

        if (stale.Count > 0)
        {
            var token = await _readToken().ConfigureAwait(false);
            var host = _readHost();
            using var http = _httpFactory.CreateClient("github");

            for (var i = 0; i < stale.Count; i += MaxBatch)
            {
                var chunk = stale.GetRange(i, Math.Min(MaxBatch, stale.Count - i));
                foreach (var (it, data) in await FetchChunkAsync(http, token, host, chunk, viewerLogin, ct).ConfigureAwait(false))
                {
                    _cache[(it.Reference, it.UpdatedAt)] = data;
                    result[it.Reference] = data;
                }
            }
        }

        InboxCacheEviction.PruneAbsent(_cache, items.Select(i => i.Reference).ToHashSet());
        return result;
    }

    private async Task<List<(RawPrInboxItem Item, BatchPrData Data)>> FetchChunkAsync(
        HttpClient http, string? token, string host,
        IReadOnlyList<RawPrInboxItem> chunk, string viewerLogin, CancellationToken ct)
    {
        var aliased = chunk.Select((it, idx) => (Alias: $"a{idx}", Item: it)).ToList();
        var query = BuildQuery(aliased);

        string body;
        try
        {
            // Route through the shared transport so the PAT same-host egress guard stays in the
            // chain. PostAsync throws HttpRequestException (StatusCode preserved) on non-2xx and
            // returns the raw 200 body verbatim. Empty variables — owner/name/number are inlined.
            body = await GitHubGraphQL.PostAsync(http, token, host, _log, query, new { }, ct).ConfigureAwait(false);
        }
        catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.TooManyRequests)
        {
            // REST parity: a hydration/awaiting 429 backs the poller off. PostAsync's exception
            // carries no Retry-After, so RetryAfter is null and the poller runs the next tick at
            // its normal cadence (InboxPoller has no separate max-backoff).
            throw new RateLimitExceededException(
                "GitHub GraphQL rate limit (HTTP 429) during inbox batch hydration.", retryAfter: null);
        }

        using var doc = JsonDocument.Parse(body);

        // Primary rate limit arrives as HTTP 200 with errors[].type == RATE_LIMITED (data:null).
        // Inspect errors[] BEFORE reading data (which is null in that case).
        if (HasRateLimitError(doc.RootElement))
            throw new RateLimitExceededException(
                "GitHub GraphQL rate limit (200/RATE_LIMITED) during inbox batch hydration.", retryAfter: null);

        var results = new List<(RawPrInboxItem, BatchPrData)>();
        if (!doc.RootElement.TryGetProperty("data", out var data) || data.ValueKind != JsonValueKind.Object)
        {
            // 200 with no usable data object (non-rate-limit errors-without-data). Degrade: every
            // ref in this chunk drops this tick (not a fallback). Observable via the log.
            Log.RefsDropped(_log, chunk.Count);
            return results;
        }

        // Cost measurement (#532 AC): record the point cost per chunk for the PR ## Proof.
        if (data.TryGetProperty("rateLimit", out var rl) && rl.ValueKind == JsonValueKind.Object)
            Log.RateLimitCost(_log, chunk.Count,
                rl.TryGetProperty("cost", out var co) && co.ValueKind == JsonValueKind.Number ? co.GetInt32() : -1,
                rl.TryGetProperty("remaining", out var re) && re.ValueKind == JsonValueKind.Number ? re.GetInt32() : -1);

        var dropped = 0;
        foreach (var (alias, it) in aliased)
        {
            try
            {
                if (data.TryGetProperty(alias, out var repoNode)
                    && repoNode.ValueKind == JsonValueKind.Object
                    && TryParse(repoNode, it, viewerLogin, out var parsed))
                    results.Add((it, parsed));
                else
                    dropped++;
            }
            catch (Exception ex) when (InboxJsonGuard.IsMalformedItem(ex))
            {
                // One malformed alias (e.g. a non-date timestamp string) drops just that ref,
                // mirroring the REST enricher's per-PR malformed-payload isolation (#322).
                dropped++;
            }
        }
        if (dropped > 0) Log.RefsDropped(_log, dropped);
        return results;
    }

    private static string BuildQuery(IReadOnlyList<(string Alias, RawPrInboxItem Item)> aliased)
    {
        var sb = new StringBuilder("query{");
        foreach (var (alias, it) in aliased)
        {
            sb.Append(alias).Append(": repository(owner:")
              .Append(JsonSerializer.Serialize(it.Reference.Owner)).Append(", name:")
              .Append(JsonSerializer.Serialize(it.Reference.Repo)).Append("){ pullRequest(number:")
              .Append(it.Reference.Number.ToString(CultureInfo.InvariantCulture))
              .Append("){ headRefOid additions deletions changedFiles commits{ totalCount } ")
              .Append("mergedAt closedAt headRepository{ pushedAt } ")
              .Append("reviews(last:100){ nodes{ author{ login } submittedAt commit{ oid } } } } } ");
        }
        sb.Append("rateLimit{ cost remaining } }");
        return sb.ToString();
    }

    private bool TryParse(JsonElement repoNode, RawPrInboxItem raw, string viewerLogin, out BatchPrData data)
    {
        data = null!;
        if (!repoNode.TryGetProperty("pullRequest", out var pr) || pr.ValueKind != JsonValueKind.Object)
            return false;

        var headSha = pr.TryGetProperty("headRefOid", out var h) ? h.GetString() ?? "" : "";
        if (string.IsNullOrEmpty(headSha)) return false;   // no head → cannot hydrate; drop

        var additions = NumOr(pr, "additions", 0);
        var deletions = NumOr(pr, "deletions", 0);
        var changedFiles = NumOr(pr, "changedFiles", 0);
        var commitCount = pr.TryGetProperty("commits", out var c) ? NumOr(c, "totalCount", 1) : 1;

        // pushedAt: BOTH guards — present object AND String-kind scalar — else fall back to UpdatedAt.
        var pushedAt = raw.UpdatedAt;
        if (pr.TryGetProperty("headRepository", out var hr) && hr.ValueKind == JsonValueKind.Object
            && hr.TryGetProperty("pushedAt", out var pa) && pa.ValueKind == JsonValueKind.String)
            pushedAt = pa.GetDateTimeOffset();

        DateTimeOffset? mergedAt = pr.TryGetProperty("mergedAt", out var ma) && ma.ValueKind == JsonValueKind.String
            ? ma.GetDateTimeOffset() : null;
        DateTimeOffset? closedAt = pr.TryGetProperty("closedAt", out var ca) && ca.ValueKind == JsonValueKind.String
            ? ca.GetDateTimeOffset() : null;

        data = new BatchPrData(headSha, additions, deletions, commitCount, changedFiles,
                               pushedAt, mergedAt, closedAt, ParseViewerLastReviewSha(pr, viewerLogin, raw.Reference));
        return true;
    }

    private static int NumOr(JsonElement obj, string name, int fallback)
        => obj.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : fallback;

    // Replicates GitHubAwaitingAuthorFilter.FetchLastReviewShaAsync against the GraphQL shape:
    // the viewer's review with the max submittedAt among reviews with a non-null submittedAt AND a
    // non-empty commit.oid. NO state filter (deliberately NOT GitHubPrParser.ParseViewerReview,
    // which excludes DISMISSED/PENDING) — see spec § Awaiting-author parity.
    private string? ParseViewerLastReviewSha(JsonElement pr, string viewerLogin, PrReference reference)
    {
        if (!pr.TryGetProperty("reviews", out var reviews)
            || !reviews.TryGetProperty("nodes", out var nodes)
            || nodes.ValueKind != JsonValueKind.Array)
            return null;

        // Documented delta 1 (spec): reviews(last:100) carries no pageInfo, so a full page is the
        // only available truncation signal. A PR with >100 reviews whose viewer's latest is older
        // than the 100 most recent could yield a stale SHA — emit a ReviewPagesCapped-style log.
        if (nodes.GetArrayLength() == MaxReviewNodes)
            Log.ReviewsTruncated(_log, reference.Owner, reference.Repo, reference.Number, MaxReviewNodes);

        string? best = null;
        DateTimeOffset? bestAt = null;
        foreach (var rv in nodes.EnumerateArray())
        {
            if (rv.ValueKind != JsonValueKind.Object) continue;

            var login = rv.TryGetProperty("author", out var au) && au.ValueKind == JsonValueKind.Object
                && au.TryGetProperty("login", out var l) ? l.GetString() : null;
            if (!string.Equals(login, viewerLogin, StringComparison.OrdinalIgnoreCase)) continue;

            var oid = rv.TryGetProperty("commit", out var cm) && cm.ValueKind == JsonValueKind.Object
                && cm.TryGetProperty("oid", out var o) ? o.GetString() : null;
            if (string.IsNullOrEmpty(oid)) continue;

            if (!rv.TryGetProperty("submittedAt", out var sa) || sa.ValueKind != JsonValueKind.String) continue;
            var at = sa.GetDateTimeOffset();

            if (bestAt is null || at > bestAt.Value) { bestAt = at; best = oid; }
        }
        return best;
    }

    private static bool HasRateLimitError(JsonElement root)
    {
        if (!root.TryGetProperty("errors", out var errors) || errors.ValueKind != JsonValueKind.Array)
            return false;
        foreach (var e in errors.EnumerateArray())
            if (e.ValueKind == JsonValueKind.Object && e.TryGetProperty("type", out var t)
                && string.Equals(t.GetString(), "RATE_LIMITED", StringComparison.Ordinal))
                return true;
        return false;
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch reader dropped {Count} ref(s) this tick (per-alias null / non-object / malformed)")]
        internal static partial void RefsDropped(ILogger logger, int count);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch reviews(last:{Cap}) returned a full page for {Owner}/{Repo}#{Number}; viewer's most-recent review may be older than the cap")]
        internal static partial void ReviewsTruncated(ILogger logger, string owner, string repo, int number, int cap);

        [LoggerMessage(Level = LogLevel.Debug,
            Message = "Inbox batch GraphQL: {Refs} ref(s), rateLimit cost={Cost} remaining={Remaining}")]
        internal static partial void RateLimitCost(ILogger logger, int refs, int cost, int remaining);
    }
}
```

> **Note:** `InboxJsonGuard.IsMalformedItem` already exists (used by the REST enricher / awaiting filter). Confirm its namespace (`PRism.GitHub.Inbox`) — it is in the same folder, so no extra `using` is required.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `dotnet test --filter "FullyQualifiedName~GitHubPrBatchReaderTests"`
Expected: PASS (all reader tests).

- [ ] **Step 5: Register the reader in DI (additive)**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, add this registration immediately after the existing `IAwaitingAuthorFilter` registration block (the old `IPrEnricher`/`IAwaitingAuthorFilter` registrations stay for now — removed in Task 5; both coexisting is harmless):

```csharp
// Batched GraphQL inbox hydration + awaiting-author reviews (#532). Late-bound host
// (Func<string>) to build the absolute GraphQL endpoint, exactly like the timeline reader.
services.AddSingleton<IPrBatchReader>(sp =>
{
    var tokens = sp.GetRequiredService<ITokenStore>();
    var factory = sp.GetRequiredService<IHttpClientFactory>();
    var config = sp.GetRequiredService<IConfigStore>();
    return new GitHubPrBatchReader(
        factory,
        () => tokens.ReadAsync(CancellationToken.None),
        () => config.Current.Github.Host,
        sp.GetRequiredService<ILogger<GitHubPrBatchReader>>());
});
```

- [ ] **Step 6: Build to verify the registration compiles**

Run: `dotnet build PRism.sln`
Expected: Build succeeded (solution still green — old enricher/awaiting impls untouched).

- [ ] **Step 7: Commit**

```bash
git add PRism.GitHub/Inbox/GitHubPrBatchReader.cs PRism.GitHub/ServiceCollectionExtensions.cs tests/PRism.GitHub.Tests/Inbox/GitHubPrBatchReaderTests.cs
git commit -m "feat(inbox): batched GraphQL GitHubPrBatchReader + DI registration (#532)"
```

---

### Task 3: Orchestrator integration + Core DI + test-double migration + golden harness

**Files:**
- Modify: `PRism.Core/Inbox/InboxRefreshOrchestrator.cs` (constructor + RefreshAsync hydration/awaiting steps)
- Modify: `PRism.Core/ServiceCollectionExtensions.cs:99-114` (orchestrator factory)
- Test: `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs` (migrate doubles + golden harness)

**Interfaces:**
- Consumes: `IPrBatchReader`, `BatchPrData` (Task 1), `AwaitingAuthorRule.IsAwaitingAuthor` (Task 1).
- Produces: `InboxRefreshOrchestrator` ctor now takes `IPrBatchReader batchReader` in place of `IPrEnricher enricher, IAwaitingAuthorFilter awaitingFilter` (all other params unchanged, same order otherwise).

- [ ] **Step 1: Migrate the orchestrator test doubles + add the golden-output harness (failing)**

In `tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs`:

(a) Replace the `IdentityPrEnricher`, `DropEnricher`, and `PassthroughAwaitingAuthorFilter` nested doubles with `IPrBatchReader` doubles:

```csharp
// Batch reader: echoes each item's hydration fields and marks every PR awaiting-author by
// default (ViewerLastReviewSha != HeadSha), matching the old Identity+Passthrough pair.
private sealed class IdentityBatchReader : IPrBatchReader
{
    public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
            items.ToDictionary(i => i.Reference, i => new BatchPrData(
                i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                i.PushedAt, i.MergedAt, i.ClosedAt,
                ViewerLastReviewSha: i.HeadSha + "-prev")));   // != HeadSha → awaiting-author kept
}

// Batch reader that simulates dropped hydration (e.g. GitHub 404 / PAT-invisible repo):
// the given PR numbers are absent from the result dict, so those refs fall back to the raw
// Search item (empty headSha) and are dropped by the orchestrator's HeadSha filter.
private sealed class DropBatchReader : IPrBatchReader
{
    private readonly HashSet<int> _drop;
    public DropBatchReader(params int[] drop) => _drop = drop.ToHashSet();
    public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
            items.Where(i => !_drop.Contains(i.Reference.Number))
                 .ToDictionary(i => i.Reference, i => new BatchPrData(
                     i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                     i.PushedAt, i.MergedAt, i.ClosedAt, i.HeadSha + "-prev")));
}
```

(b) Update the `Build` helper signature: replace the `IPrEnricher? enricher` and `IAwaitingAuthorFilter? awaitingFilter` parameters with a single `IPrBatchReader? batchReader`, and update the `new InboxRefreshOrchestrator(...)` call to pass `batchReader ?? new IdentityBatchReader()` in the batch-reader position (the two old positional args become one). Update any call site that passed `enricher:` / `awaitingFilter:` named args (e.g. the `DropEnricher` tests) to pass `batchReader: new DropBatchReader(...)` instead.

(c) Add the golden-output harness (the spec's recast test 9 — there is no live REST path to compare against once the impls are deleted, so assert the batch path reproduces a hand-authored golden `PrInboxItem` set encoding the documented REST semantics):

```csharp
[Fact] // Test 9 — golden-output harness: batch path reproduces the documented REST PrInboxItem shape
public async Task Batch_path_produces_golden_pr_inbox_items()
{
    var updated = new DateTimeOffset(2026, 6, 23, 9, 0, 0, TimeSpan.Zero);
    var pushed = new DateTimeOffset(2026, 6, 23, 8, 30, 0, TimeSpan.Zero);
    var rawReviewReq = new RawPrInboxItem(
        Ref(101), "Add feature", "octocat", "acme/api", updated, pushed,
        CommentCount: 0, Additions: 12, Deletions: 3, HeadSha: "head101", CommitCount: 5, ChangedFiles: 4);

    // Batch reader returns hydration verbatim + an older review SHA (so awaiting-author keeps it).
    var batch = new StubBatchReader(new Dictionary<PrReference, BatchPrData>
    {
        [Ref(101)] = new("head101", 12, 3, 5, 4, pushed, null, null, "head100"),
    });

    var sut = Build(
        config: ConfigStoreFake(ConfigWithSections(reviewRequested: true, awaitingAuthor: false,
                                                   authoredByMe: false, mentioned: false)),
        sections: new FakeSectionQueryRunner(_ => new Dictionary<string, IReadOnlyList<RawPrInboxItem>>
        {
            ["review-requested"] = new[] { rawReviewReq },
        }),
        batchReader: batch);

    await sut.RefreshAsync(CancellationToken.None);
    var item = sut.Current!.Sections["review-requested"].Single();

    item.Reference.Should().Be(Ref(101));
    item.HeadSha.Should().Be("head101");
    item.Additions.Should().Be(12);
    item.Deletions.Should().Be(3);
    item.CommitCount.Should().Be(5);
    item.ChangedFiles.Should().Be(4);
    item.PushedAt.Should().Be(pushed);
    item.MergedAt.Should().BeNull();
    item.ClosedAt.Should().BeNull();
}

// Minimal IPrBatchReader returning a fixed dictionary (golden-harness fixtures).
private sealed class StubBatchReader : IPrBatchReader
{
    private readonly IReadOnlyDictionary<PrReference, BatchPrData> _data;
    public StubBatchReader(IReadOnlyDictionary<PrReference, BatchPrData> data) => _data = data;
    public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        => Task.FromResult(_data);
}
```

> Add an awaiting-author assertion too, if an existing test covered it: build a `review-requested`-only and an `awaiting-author` section where the batch returns `ViewerLastReviewSha == headSha` for one PR (dropped) and `!= headSha` for another (kept), asserting `AwaitingAuthorRule` is applied. Reuse the existing awaiting-author test's section fixture; only its expected-kept set changes (driven by the stub's review SHA rather than the passthrough filter).

- [ ] **Step 2: Run the orchestrator tests to verify they fail**

Run: `dotnet test --filter "FullyQualifiedName~InboxRefreshOrchestratorTests"`
Expected: FAIL — `InboxRefreshOrchestrator` still has the old constructor; `IdentityBatchReader` doesn't match.

- [ ] **Step 3: Rewire the orchestrator constructor + fields**

In `PRism.Core/Inbox/InboxRefreshOrchestrator.cs`:

Replace the two fields:
```csharp
    private readonly IPrEnricher _enricher;
    private readonly IAwaitingAuthorFilter _awaitingFilter;
```
with:
```csharp
    private readonly IPrBatchReader _batchReader;
```

Replace the two constructor parameters `IPrEnricher enricher, IAwaitingAuthorFilter awaitingFilter` with `IPrBatchReader batchReader`, and the two assignments:
```csharp
        _enricher = enricher;
        _awaitingFilter = awaitingFilter;
```
with:
```csharp
        _batchReader = batchReader;
```

- [ ] **Step 4: Rewire `RefreshAsync` hydration + awaiting steps**

Replace the block from `var enriched = await _enricher.EnrichAsync(...)` (line ~143) through the end of the awaiting-author `if` block (line ~161) with:

```csharp
            var viewerLogin = _viewerLoginProvider();
            var batch = await _batchReader.ReadAsync(allRawDistinct, viewerLogin, ct).ConfigureAwait(false);
            // Map batch hydration onto each raw item; refs the batch didn't resolve are absent →
            // they fall back to the raw item (empty HeadSha) → dropped by the Where filter below.
            var byRef = allRawDistinct
                .Where(r => batch.ContainsKey(r.Reference))
                .ToDictionary(r => r.Reference, r =>
                {
                    var b = batch[r.Reference];
                    return r with
                    {
                        HeadSha = b.HeadSha, Additions = b.Additions, Deletions = b.Deletions,
                        CommitCount = b.CommitCount, ChangedFiles = b.ChangedFiles, PushedAt = b.PushedAt,
                        MergedAt = b.MergedAt, ClosedAt = b.ClosedAt,
                    };
                });
            Log.PrEnrichmentComplete(_log, allRawDistinct.Count, byRef.Count);

            var rawWithEnrichment = raw.ToDictionary(
                kv => kv.Key,
                kv => (IReadOnlyList<RawPrInboxItem>)kv.Value
                    .Select(r => byRef.TryGetValue(r.Reference, out var e) ? e : r)
                    .Where(r => !string.IsNullOrEmpty(r.HeadSha))
                    .ToList());

            // Awaiting-author: apply the inclusion predicate using the batch's ViewerLastReviewSha
            // (replaces the per-PR REST review walk). Items here already have a non-empty HeadSha,
            // so they are guaranteed present in `batch`.
            if (rawWithEnrichment.TryGetValue("awaiting-author", out var rawSec2))
            {
                var filtered = (IReadOnlyList<RawPrInboxItem>)rawSec2
                    .Where(r => AwaitingAuthorRule.IsAwaitingAuthor(
                        batch.TryGetValue(r.Reference, out var b) ? b.ViewerLastReviewSha : null,
                        r.HeadSha))
                    .ToList();
                Log.AwaitingAuthorFiltered(_log, rawSec2.Count, filtered.Count);
                rawWithEnrichment["awaiting-author"] = filtered;
            }
```

> The `closedRaw` materialization later (the `byRef.TryGetValue(r.Reference, out var e)` block) is unchanged — `byRef` now holds the batch-hydrated items, so recently-closed PRs still pick up `MergedAt`/`ClosedAt`.

- [ ] **Step 5: Update the Core DI factory**

In `PRism.Core/ServiceCollectionExtensions.cs`, in the `IInboxRefreshOrchestrator` factory (lines ~99-114), replace the two lines:
```csharp
                sp.GetRequiredService<IPrEnricher>(),
                sp.GetRequiredService<IAwaitingAuthorFilter>(),
```
with:
```csharp
                sp.GetRequiredService<IPrBatchReader>(),
```

Also update the `<remarks>` XML-doc on `AddPrismCore` (around line 37): it lists `<c>IPrEnricher</c>, <c>IAwaitingAuthorFilter</c>, <c>ICiFailingDetector</c>` as cross-method dependencies — replace the first two with `<c>IPrBatchReader</c>` so the doc doesn't name the soon-to-be-deleted interfaces. (These are `<c>` literals, not `<see cref>`, so they don't break the build — but they go stale; fix here to keep the "0 warnings, no stale docs" bar.)

- [ ] **Step 6: Build + run the orchestrator tests**

Run: `dotnet build PRism.sln`
Expected: Build succeeded.

Run: `dotnet test --filter "FullyQualifiedName~InboxRefreshOrchestratorTests"`
Expected: PASS (including the golden harness + migrated doubles).

- [ ] **Step 7: Commit**

```bash
git add PRism.Core/Inbox/InboxRefreshOrchestrator.cs PRism.Core/ServiceCollectionExtensions.cs tests/PRism.Core.Tests/Inbox/InboxRefreshOrchestratorTests.cs
git commit -m "refactor(inbox): orchestrator uses IPrBatchReader for hydration + awaiting-author (#532)"
```

---

### Task 4: Web test-mode swap (`FakePrBatchReader`)

**Files:**
- Create: `PRism.Web/TestHooks/FakePrBatchReader.cs`
- Delete: `PRism.Web/TestHooks/FakePrEnricher.cs`
- Modify: `PRism.Web/Program.cs:138-155` (test-mode DI overrides)

**Interfaces:**
- Consumes: `IPrBatchReader`, `BatchPrData` (Task 1).
- Produces: `FakePrBatchReader : IPrBatchReader` (passthrough hydration, no network).

- [ ] **Step 1: Create the fake batch reader**

`PRism.Web/TestHooks/FakePrBatchReader.cs`:

```csharp
using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Web.TestHooks;

// Test-only IPrBatchReader — echoes each item's hydration fields, never hits GitHub (the real
// reader would 401/404 on the fake scenario PR). The e2e fake section runner only ever populates
// "review-requested" (never "awaiting-author"), so ViewerLastReviewSha is immaterial here.
internal sealed class FakePrBatchReader : IPrBatchReader
{
    public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
            items.ToDictionary(i => i.Reference, i => new BatchPrData(
                i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                i.PushedAt, i.MergedAt, i.ClosedAt, ViewerLastReviewSha: null)));
}
```

- [ ] **Step 2: Delete the old fake**

```bash
git rm PRism.Web/TestHooks/FakePrEnricher.cs
```

- [ ] **Step 3: Update the test-mode DI overrides**

In `PRism.Web/Program.cs`, in the `PRISM_E2E_FAKE_REVIEW` block:

In the `RemoveAll` type list (line ~141), replace `typeof(PRism.Core.Inbox.IPrEnricher)` with `typeof(PRism.Core.Inbox.IPrBatchReader)`.

Replace the registration line (line ~154):
```csharp
    builder.Services.AddSingleton<PRism.Core.Inbox.IPrEnricher, FakePrEnricher>();
```
with:
```csharp
    builder.Services.AddSingleton<PRism.Core.Inbox.IPrBatchReader, FakePrBatchReader>();
```

- [ ] **Step 4: Build to verify**

Run: `dotnet build PRism.sln`
Expected: Build succeeded.

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/TestHooks/FakePrBatchReader.cs PRism.Web/Program.cs
git commit -m "test(inbox): swap e2e FakePrEnricher → FakePrBatchReader (#532)"
```

---

### Task 5: Delete the dead REST impls + interfaces + their tests; final verify

**Files:**
- Delete: `PRism.GitHub/Inbox/GitHubPrEnricher.cs`
- Delete: `PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs`
- Delete: `PRism.Core/Inbox/IPrEnricher.cs`
- Delete: `PRism.Core/Inbox/IAwaitingAuthorFilter.cs`
- Delete: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs`
- Delete: `tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherCloseStateTests.cs` (also constructs `new GitHubPrEnricher(...)`; its MergedAt/ClosedAt coverage moves to the GraphQL path via Task 2's `Parses_hydration_fields` + the orchestrator golden harness)
- Delete: `tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs`
- Modify: `PRism.GitHub/ServiceCollectionExtensions.cs` (remove the `IPrEnricher` + `IAwaitingAuthorFilter` registrations)
- Modify: stale comments in `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs`, `PRism.GitHub/GitHubReviewService.cs`, `PRism.GitHub/GitHubPrParser.cs` (build-safe, but they name the deleted classes — see Step 3)

- [ ] **Step 1: Remove the GitHub DI registrations**

In `PRism.GitHub/ServiceCollectionExtensions.cs`, delete the `services.AddSingleton<IPrEnricher>(...)` block (lines ~105-110) and the `services.AddSingleton<IAwaitingAuthorFilter>(...)` block (lines ~112-120). Also update the XML-doc summary on `AddPrismGitHub` that enumerates the inbox-pipeline implementations: replace the `IPrEnricher`, `IAwaitingAuthorFilter` mentions with `IPrBatchReader`.

- [ ] **Step 2: Delete the dead files**

```bash
git rm PRism.GitHub/Inbox/GitHubPrEnricher.cs \
       PRism.GitHub/Inbox/GitHubAwaitingAuthorFilter.cs \
       PRism.Core/Inbox/IPrEnricher.cs \
       PRism.Core/Inbox/IAwaitingAuthorFilter.cs \
       tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherTests.cs \
       tests/PRism.GitHub.Tests/Inbox/GitHubPrEnricherCloseStateTests.cs \
       tests/PRism.GitHub.Tests/Inbox/GitHubAwaitingAuthorFilterTests.cs
```

- [ ] **Step 3: Grep for remaining references; clean stale comments**

Run: `git grep -n "IPrEnricher\|IAwaitingAuthorFilter\|GitHubPrEnricher\|GitHubAwaitingAuthorFilter\|FakePrEnricher"`

Expected remaining matches are **comments only** (build-safe) — clean each so the deletion looks complete and nobody is misled:
- `PRism.GitHub/Inbox/GitHubCiFailingDetector.cs` (~line 160) — comment "GitHubPrEnricher.EnrichAsync early-returns…" → reword to "the batch reader early-returns…".
- `PRism.GitHub/GitHubReviewService.cs` (~line 537) — comment "…GitHubSectionQueryRunner and GitHubPrEnricher" → drop the `GitHubPrEnricher` mention.
- `PRism.GitHub/GitHubPrParser.cs` (~line 269) — comment "…mirrors GitHubAwaitingAuthorFilter" → reword to "…mirrors the inbox batch reader's awaiting-author SHA selection".

Any match that is actual **code** (not a comment) outside `docs/` is a missed consumer — fix it before building.

- [ ] **Step 4: Full build**

Run: `dotnet build PRism.sln`
Expected: Build succeeded, 0 warnings introduced.

- [ ] **Step 5: Full test suite**

Run: `dotnet test PRism.sln`
Expected: All tests pass. (If `AiUsageEndpointTests` or known SSE/poller flakes appear, re-run once — they are documented flakes unrelated to this change.)

- [ ] **Step 6: Measurement for the PR `## Proof`**

Launch the app against the real token store per the live-validation memory (`run.ps1 -Reset None --no-browser`, serve detached) and capture, from the Debug logs, the inbox batch reader's `rateLimit cost=… remaining=…` lines and the round-trip count for a representative cold refresh vs. a quiescent tick. Record before/after (REST `4 + N + N` vs GraphQL `4 + ceil(stale/100)`) in the PR `## Proof` section. This is not a CI gate.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor(inbox): delete REST enricher + awaiting-author filter, now batched (#532)"
```

---

## Self-Review

**Spec coverage:**
- One aliased-batch reader replaces REST hydration + awaiting walk → Tasks 1, 2, 3, 5. ✅
- `(ref, UpdatedAt)` caching, quiescent → 0 batches; eviction on full-cache-hit tick → Task 2 (tests 7/7b/7c). ✅
- `>100` split → Task 2 (test 3). ✅
- Rate-limit error model (429 + 200/RATE_LIMITED → throw; other → propagate; per-alias → drop) → Task 2 (tests 8a/8b/8c, 4). ✅
- `pushedAt` both guards → Task 2 (tests 6a/6b). ✅
- Awaiting-author parity (no state filter, max submittedAt, non-empty oid) → Task 2 (tests 5a/5b) + predicate Task 1. ✅
- Delta-1 truncation log (exactly-100 review nodes) → Task 2 (test 5c). ✅
- Golden-output harness (recast test 9) → Task 3. ✅
- Inclusion-predicate unit test (test 10) → Task 1. ✅
- Test-double migration (test 11) → Tasks 3 (orchestrator doubles) + 4 (web fake). ✅
- CI detection unchanged → not touched (verified: no edits to `GitHubCiFailingDetector`). ✅
- Zero FE/DTO/schema change → no `frontend/` edits; `RawPrInboxItem`/`PrInboxItem` untouched. ✅
- Measurement in PR Proof → Task 2 logs cost; Task 5 step 6 records it. ✅
- Both REST impls + interfaces deleted → Task 5. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✅

**Type consistency:** `ReadAsync(IReadOnlyList<RawPrInboxItem>, string, CancellationToken)` and `BatchPrData(HeadSha, Additions, Deletions, CommitCount, ChangedFiles, PushedAt, MergedAt, ClosedAt, ViewerLastReviewSha)` are used identically across Tasks 1–4. `AwaitingAuthorRule.IsAwaitingAuthor(string?, string)` consistent in Tasks 1 and 3. ✅
