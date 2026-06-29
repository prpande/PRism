using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;   // shared CapturingLogger<T> (.Entries), FakeHttpClientFactory, FakeHttpMessageHandler
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
    // Includes definitive readiness fields (isDraft/mergeable/mergeStateStatus) so that open-PR
    // responses cache normally. Tests that cover specific readiness scenarios use their own inline
    // JSON bodies. Open PRs in production always receive these fields from the includeReadiness query.
    private static string OneAliasOk(
        string headSha = "head1", int additions = 5, int deletions = 2, int changed = 3,
        int commits = 4, string pushedAt = "2026-06-23T11:00:00Z",
        string? mergedAt = null, string? closedAt = null, string reviewsJson = "[]")
    {
        string Q(string? s) => s is null ? "null" : $"\"{s}\"";
        // Use string.Format to avoid raw-string-literal escaping issues with consecutive `}}}`.
        return string.Format(CultureInfo.InvariantCulture,
            """
            {{"data":{{"a0":{{"pullRequest":{{
              "headRefOid":"{0}","additions":{1},"deletions":{2},
              "changedFiles":{3},"commits":{{"totalCount":{4}}},
              "mergedAt":{5},"closedAt":{6},
              "isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,
              "headRepository":{{"pushedAt":"{7}"}},
              "reviews":{{"nodes":{8}}},
              "latestReviews":{{"nodes":[]}},"reviewRequests":{{"nodes":[]}}
            }}}}}},"rateLimit":{{"cost":1,"remaining":4999}}}}
            """,
            headSha, additions, deletions, changed, commits,
            Q(mergedAt), Q(closedAt), pushedAt, reviewsJson);
    }

    // Two fully-hydrated aliases (a0→head h7, a1→head h8), no reviews.
    // Includes definitive readiness fields so both aliases are cacheable.
    private static string TwoAliasOk()
        => """
        {"data":{
          "a0":{"pullRequest":{"headRefOid":"h7","additions":0,"deletions":0,"changedFiles":0,
            "commits":{"totalCount":1},"mergedAt":null,"closedAt":null,
            "isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,
            "headRepository":{"pushedAt":"2026-06-23T10:00:00Z"},
            "reviews":{"nodes":[]},"latestReviews":{"nodes":[]},"reviewRequests":{"nodes":[]}}},
          "a1":{"pullRequest":{"headRefOid":"h8","additions":0,"deletions":0,"changedFiles":0,
            "commits":{"totalCount":1},"mergedAt":null,"closedAt":null,
            "isDraft":false,"mergeable":"MERGEABLE","mergeStateStatus":"CLEAN","reviewDecision":null,
            "headRepository":{"pushedAt":"2026-06-23T10:00:00Z"},
            "reviews":{"nodes":[]},"latestReviews":{"nodes":[]},"reviewRequests":{"nodes":[]}}}},
        "rateLimit":{"cost":1,"remaining":1}}
        """;

    // A reader wired to the SHARED CapturingLogger<T> (tests/PRism.GitHub.Tests/TestHelpers/
    // CapturingLogger.cs — exposes .Entries as List<(LogLevel Level, string Message)>) so tests can
    // assert log emissions (e.g. truncation). Do NOT add a local capturing-logger duplicate.
    private static (GitHubPrBatchReader Reader, CapturingLogger<GitHubPrBatchReader> Log) MakeReaderWithLog(
        HttpStatusCode code, string json)
    {
        var log = new CapturingLogger<GitHubPrBatchReader>();
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(FakeHttpMessageHandler.Returns(code, json), new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com", log);
        return (reader, log);
    }

    // #665 byte-identity characterization: pins the EXACT posted open-PR (includeReadiness:true)
    // query so the shared dispatch/envelope extraction cannot change the wire output. Golden
    // captured from the pre-refactor BuildQuery output.
    [Fact]
    public async Task Posts_byte_identical_open_query()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """{"data":{}}""");
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.ReadAsync(new[] { Raw(7, "acme", "api") }, "viewer", CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{a0: repository(owner:"acme", name:"api"){ pullRequest(number:7){ headRefOid additions deletions changedFiles commits{ totalCount } mergedAt closedAt headRepository{ pushedAt } isDraft mergeable mergeStateStatus reviewDecision reviews(last:100){ nodes{ author{ login } submittedAt commit{ oid } } } latestReviews(first:20){ nodes{ author{ login avatarUrl } state } } reviewRequests(first:20){ nodes{ requestedReviewer{ ... on User{ login avatarUrl } ... on Team{ name } } } } } } rateLimit{ cost remaining } }""");
    }

    // #665 byte-identity: closed-PR (includeReadiness:false) light selection — no readiness block.
    [Fact]
    public async Task Posts_byte_identical_closed_query()
    {
        var handler = new RecordingHttpMessageHandler(HttpStatusCode.OK, """{"data":{}}""");
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        await reader.ReadAsync(new[] { Raw(7, "acme", "api") with { IsClosedHistory = true } }, "viewer", CancellationToken.None);

        GraphQlRequest.QueryOf(handler.LastRequestBody).Should().Be(
            """query{a0: repository(owner:"acme", name:"api"){ pullRequest(number:7){ headRefOid additions deletions changedFiles commits{ totalCount } mergedAt closedAt headRepository{ pushedAt } } } rateLimit{ cost remaining } }""");
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

        // System.Text.Json serializes " as " (Unicode escape) inside JSON string values.
        // Decode the payload to extract the raw query string for readable assertions.
        using var doc = System.Text.Json.JsonDocument.Parse(sent!);
        var query = doc.RootElement.GetProperty("query").GetString()!;
        query.Should().Contain("a0: repository(owner:\"acme\", name:\"api\")");
        query.Should().Contain("pullRequest(number:7)");
        query.Should().Contain("reviews(last:100)");
        // #593 — open-PR readiness selection carries reviewer avatars + the still-requested reviewers.
        query.Should().Contain("latestReviews(first:20){ nodes{ author{ login avatarUrl } state } }");
        query.Should().Contain("reviewRequests(first:20)");
        query.Should().Contain("rateLimit");
        // The inbox batch query must NOT fetch the top-level viewer node (detail query does).
        // Match "viewer{login}" specifically — a bare "viewer{" now substring-collides with the
        // #593 reviewRequests "requestedReviewer{" selection.
        query.Should().NotContain("viewer{login}");
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
        log.Entries.Should().Contain(e => e.Message.Contains("full page"));
    }

    [Fact] // Test 5d — a malformed (non-date) submittedAt skips only that review node; PR still hydrated
    public async Task Malformed_submittedAt_skips_node_not_whole_pr()
    {
        const string reviews = """
        [{"author":{"login":"viewer"},"submittedAt":"not-a-date","commit":{"oid":"bad"}},
         {"author":{"login":"viewer"},"submittedAt":"2026-06-21T00:00:00Z","commit":{"oid":"good"}}]
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, OneAliasOk(headSha: "abc", reviewsJson: reviews));
        var r = await reader.ReadAsync(new[] { Raw(7) }, "viewer", CancellationToken.None);
        var d = r[new PrReference("acme", "api", 7)];
        d.HeadSha.Should().Be("abc");               // PR still hydrated, not dropped
        d.ViewerLastReviewSha.Should().Be("good");  // bad node skipped, valid one still selected
    }

    [Fact] // Test 5e — viewerLogin match is case-insensitive (author login casing differs)
    public async Task ViewerLastReviewSha_matches_login_case_insensitively()
    {
        const string reviews = """
        [{"author":{"login":"viewer"},"submittedAt":"2026-06-22T00:00:00Z","commit":{"oid":"mine"}}]
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, OneAliasOk(reviewsJson: reviews));
        var r = await reader.ReadAsync(new[] { Raw(7) }, "Viewer", CancellationToken.None);
        r[new PrReference("acme", "api", 7)].ViewerLastReviewSha.Should().Be("mine");
    }

    [Fact] // Test 6a — pushedAt: headRepository null → UpdatedAt fallback
    public async Task PushedAt_falls_back_when_headRepository_null()
    {
        const string json = """
        {"data":{"a0":{"pullRequest":{
          "headRefOid":"h","additions":0,"deletions":0,"changedFiles":0,"commits":{"totalCount":1},
          "mergedAt":null,"closedAt":null,"headRepository":null,"reviews":{"nodes":[]}
        }}},"rateLimit":{"cost":1,"remaining":4999}}
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
        }}},"rateLimit":{"cost":1,"remaining":4999}}
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
            var body = "{\"data\":{" + string.Join(",", aliases) + "},\"rateLimit\":{\"cost\":1,\"remaining\":1}}";
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        var items = Enumerable.Range(1, 150).Select(n => Raw(n)).ToList();
        var r = await reader.ReadAsync(items, "viewer", CancellationToken.None);

        batchCount.Should().Be(3);   // MaxBatch=50 → 50 + 50 + 50 (#593)
        r.Should().HaveCount(150);
    }

    // Guard (#593): a brace-imbalanced query shipped once — the latestReviews append had one extra
    // '}', which closed the top-level query{} after a0 so a1 was a GraphQL syntax error → GitHub
    // returned all-null nodes → every PR dropped → empty inbox. NO test caught it because they all
    // mock the RESPONSE and never validate the SENT query. This validates BOTH the full (open) and
    // light (closed) query shapes: braces balanced AND the query block never closes before the end.
    [Fact]
    public async Task Built_queries_are_brace_balanced_and_never_close_early()
    {
        var sentQueries = new List<string>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var payload = req.Content!.ReadAsStringAsync().GetAwaiter().GetResult();
            // Extract the bare GraphQL query from the {"query":"...","variables":{}} POST body so the
            // brace walk below sees the query, not the JSON wrapper.
            var q = System.Text.Json.JsonDocument.Parse(payload).RootElement.GetProperty("query").GetString()!;
            sentQueries.Add(q);
            var aliases = System.Text.RegularExpressions.Regex.Matches(q, @"a(\d+): repository")
                .Select(m => $"\"a{m.Groups[1].Value}\":{{\"pullRequest\":{{\"headRefOid\":\"h\",\"additions\":0,\"deletions\":0,\"changedFiles\":0,\"commits\":{{\"totalCount\":1}},\"mergedAt\":null,\"closedAt\":null,\"headRepository\":{{\"pushedAt\":\"2026-06-23T10:00:00Z\"}},\"reviews\":{{\"nodes\":[]}}}}}}");
            var body = "{\"data\":{" + string.Join(",", aliases) + "},\"rateLimit\":{\"cost\":1,\"remaining\":1}}";
            return new HttpResponseMessage(HttpStatusCode.OK)
            { Content = new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json") };
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"), () => "https://github.com");

        // One open (full readiness selection) + one closed (light selection) → two distinct queries.
        var items = new[] { Raw(1), Raw(2) with { IsClosedHistory = true } };
        await reader.ReadAsync(items, "viewer", CancellationToken.None);

        sentQueries.Should().HaveCount(2, "open and closed PRs take separate queries");
        foreach (var q in sentQueries)
        {
            q.Count(c => c == '{').Should().Be(q.Count(c => c == '}'), "every '{{' must be closed in: {0}", q);
            // Walk depth: it must stay > 0 from the first '{' until the final '}' — a premature
            // return to 0 means an alias escaped the query block (the original bug).
            var depth = 0; var firstZeroAt = -1;
            for (var i = 0; i < q.Length; i++)
            {
                if (q[i] == '{') depth++;
                else if (q[i] == '}') { depth--; if (depth == 0 && firstZeroAt < 0) firstZeroAt = i; }
            }
            firstZeroAt.Should().Be(q.TrimEnd().Length - 1,
                "the query block must close exactly once, at the very end (no early close): {0}", q);
        }
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

    [Fact] // Test 7d — viewer change (PAT swap) clears the cache → re-fetch under the new identity
    public async Task Refetches_when_viewer_changes_even_if_updatedAt_unchanged()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        var items = new[] { Raw(7, updated: T0) };
        await reader.ReadAsync(items, "alice", CancellationToken.None);  // calls=1, caches under alice
        await reader.ReadAsync(items, "bob", CancellationToken.None);    // viewer changed → cache cleared → re-fetch
        calls().Should().Be(2);
    }

    [Fact] // Test 7e — a case-only viewerLogin change is the SAME viewer → cache retained, no re-fetch
    public async Task Same_viewer_different_casing_keeps_cache()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        var items = new[] { Raw(7, updated: T0) };
        await reader.ReadAsync(items, "alice", CancellationToken.None);  // calls=1, caches under alice
        await reader.ReadAsync(items, "Alice", CancellationToken.None);  // same viewer (OrdinalIgnoreCase) → no clear
        calls().Should().Be(1);
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

    [Fact] // Test N — merge-readiness derivation + collapsed review counts
    public async Task Derives_merge_readiness_and_collapsed_review_counts_per_alias()
    {
        // A clean, mergeable PR where one reviewer changed-then-approved (must collapse to 1 approval, 0 changes)
        // and another requested changes -> reviewDecision CHANGES_REQUESTED on a CLEAN PR -> ReadyWithChangesRequested.
        const string body = """
        { "data": {
            "a0": { "pullRequest": {
                "headRefOid": "deadbeef", "additions": 1, "deletions": 0, "changedFiles": 1,
                "commits": { "totalCount": 1 }, "mergedAt": null, "closedAt": null,
                "isDraft": false, "mergeable": "MERGEABLE", "mergeStateStatus": "CLEAN",
                "reviewDecision": "CHANGES_REQUESTED",
                "headRepository": { "pushedAt": "2026-06-24T00:00:00Z" },
                "reviews": { "nodes": [] },
                "latestReviews": { "nodes": [
                    { "author": { "login": "alice" }, "state": "APPROVED" },
                    { "author": { "login": "bob" }, "state": "CHANGES_REQUESTED" }
                ] }
            } },
            "rateLimit": { "cost": 1, "remaining": 4999 } } }
        """;
        var (reader, _) = MakeReader(HttpStatusCode.OK, body);
        var raw = Raw(1);

        var result = await reader.ReadAsync(new[] { raw }, "viewer", CancellationToken.None);

        var item = result[new PrReference("acme", "api", 1)];
        item.MergeReadiness.Should().Be(MergeReadiness.ReadyWithChangesRequested);
        item.Approvals.Should().Be(1);
        item.ChangesRequested.Should().Be(1);
    }

    [Fact] // Empty input → empty, no HTTP
    public async Task Empty_input_returns_empty_without_http()
    {
        var (reader, calls) = MakeReader(HttpStatusCode.OK, OneAliasOk());
        var r = await reader.ReadAsync(Array.Empty<RawPrInboxItem>(), "viewer", CancellationToken.None);
        r.Should().BeEmpty();
        calls().Should().Be(0);
    }

    // ---- Task-8 helpers ----

    // Builds a single-alias (a0) response body for an open PR with explicit readiness fields.
    // Uses string.Format ({{/}} escaping) to avoid CS9007: raw $$-string literals forbid }}
    // sequences that appear naturally in JSON (e.g. closing multiple nested objects).
    private static string OpenPrReadinessBody(
        bool isDraft = false, string? mergeable = "UNKNOWN", string? mergeStateStatus = "UNKNOWN")
    {
        var draftVal = isDraft ? "true" : "false";
        var mergeableJson = mergeable is null ? "null" : $"\"{mergeable}\"";
        var mssJson = mergeStateStatus is null ? "null" : $"\"{mergeStateStatus}\"";
        return string.Format(
            CultureInfo.InvariantCulture,
            """
            {{"data":{{"a0":{{"pullRequest":{{
              "headRefOid":"head1","additions":0,"deletions":0,"changedFiles":0,
              "commits":{{"totalCount":1}},"mergedAt":null,"closedAt":null,
              "isDraft":{0},"mergeable":{1},"mergeStateStatus":{2},"reviewDecision":null,
              "headRepository":{{"pushedAt":"2026-06-23T10:00:00Z"}},
              "reviews":{{"nodes":[]}},"latestReviews":{{"nodes":[]}},"reviewRequests":{{"nodes":[]}}
            }}}}}},"rateLimit":{{"cost":1,"remaining":4999}}}}
            """,
            draftVal, mergeableJson, mssJson);
    }

    // Creates a reader whose HTTP handler returns one body per ReadAsync call in order.
    private static GitHubPrBatchReader SequenceReader(params string[] bodies)
    {
        var index = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            var body = bodies[index++];
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new System.Net.Http.StringContent(body, System.Text.Encoding.UTF8, "application/json")
            };
        });
        return new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");
    }

    // ---- Task-8 tests ----

    [Fact] // Task-8 A — open non-draft UNKNOWN is not cached; second read re-fetches and gets the resolved value
    public async Task OpenNonDraft_unknown_readiness_is_not_cached()
    {
        var reader = SequenceReader(
            OpenPrReadinessBody(isDraft: false, mergeable: "UNKNOWN",   mergeStateStatus: "UNKNOWN"),  // 1st fetch — still computing
            OpenPrReadinessBody(isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN"));   // 2nd fetch — resolved

        var item = Raw(7, updated: T0);
        var r1 = await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None);
        var r2 = await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None); // same (ref,UpdatedAt)

        r1[item.Reference].MergeReadiness.Should().Be(MergeReadiness.None);   // first read: still computing
        r2[item.Reference].MergeReadiness.Should().Be(MergeReadiness.Ready);  // re-fetched, NOT cache-served
    }

    [Fact] // Task-8 B — mergeStateStatus-lag derived-None is NOT cached (gate is on derived value, not raw mergeable)
    public async Task MergeStateStatus_lag_none_is_not_cached()
    {
        var reader = SequenceReader(
            OpenPrReadinessBody(isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "UNKNOWN"),  // lag: mergeable definitive but mss stale
            OpenPrReadinessBody(isDraft: false, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN"));   // fully resolved

        var item = Raw(7, updated: T0);
        await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None);
        var r2 = await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None);

        r2[item.Reference].MergeReadiness.Should().Be(MergeReadiness.Ready); // re-fetched, not frozen on None
    }

    [Fact] // Task-8 C — draft None IS cached (drafts have no badge; re-fetching is pointless)
    public async Task Draft_none_is_cached()
    {
        var called = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            called++;
            if (called > 1)
                throw new InvalidOperationException($"Handler called {called} times — draft should have been cached, not re-fetched");
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new System.Net.Http.StringContent(
                    OpenPrReadinessBody(isDraft: true, mergeable: null, mergeStateStatus: "UNKNOWN"),
                    System.Text.Encoding.UTF8, "application/json")
            };
        });
        var reader = new GitHubPrBatchReader(
            new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("token"),
            () => "https://github.com");

        var item = Raw(7, updated: T0);
        await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None);
        var r2 = await reader.ReadAsync(new[] { item }, "viewer", CancellationToken.None); // served from cache — no 2nd fetch

        r2[item.Reference].MergeReadiness.Should().Be(MergeReadiness.None);
    }
}
