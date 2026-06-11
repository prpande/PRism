using System.Net;
using System.Text;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubAwaitingAuthorFilterTests
{
    private const string ViewerLogin = "alice";

    private static GitHubAwaitingAuthorFilter BuildSut(HttpMessageHandler handler) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"));

    private static GitHubAwaitingAuthorFilter BuildSut(
        HttpMessageHandler handler, ILogger<GitHubAwaitingAuthorFilter> log) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"), log);

    private static RawPrInboxItem Raw(int n, string headSha = "new", string repo = "acme/api")
    {
        var parts = repo.Split('/');
        return new RawPrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            0, 0, 0, headSha, 1);
    }

    private static string ReviewsResponse(
        string viewerLogin, string lastReviewSha, string submittedAt = "2020-01-01T00:00:00Z") => $$"""
        [
            { "user": { "login": "{{viewerLogin}}" }, "commit_id": "{{lastReviewSha}}", "submitted_at": "{{submittedAt}}" }
        ]
        """;

    private static HttpResponseMessage Respond(HttpStatusCode code, string body) => new(code)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    [Fact]
    public async Task Includes_pr_with_newer_commits_than_last_review()
    {
        // reviews returns viewer's last review at sha "old"; PR HeadSha is "new"
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old")));
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

        result.Should().HaveCount(1);
        result[0].Reference.Number.Should().Be(1);
    }

    [Fact]
    public async Task Excludes_pr_where_viewer_review_matches_head_sha()
    {
        // reviews returns viewer's last review at sha "head"; PR HeadSha is "head"
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "head")));
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().BeEmpty();
    }

    [Fact]
    public async Task Pr_404_is_filtered_silently()
    {
        // handler returns 404 for pulls/{n}/reviews → PR excluded; no exception
        var handler = new FakeHttpMessageHandler(_ =>
            Respond(HttpStatusCode.NotFound, "{}"));
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], default);

        await act.Should().NotThrowAsync();
        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], default);
        result.Should().BeEmpty();
    }

    [Fact]
    public async Task Cache_hit_skips_http()
    {
        // call once for (pr, sha); call again same key → second call: zero new HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "new");
        await sut.FilterAsync(ViewerLogin, [candidate], default);
        await sut.FilterAsync(ViewerLogin, [candidate], default);

        requestCount.Should().Be(1);
    }

    [Fact]
    public async Task Cache_invalidates_on_head_sha_change()
    {
        // call once with sha A, then with same prRef but sha B → two HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        var sut = BuildSut(handler);

        await sut.FilterAsync(ViewerLogin, [Raw(1, "sha-A")], default);
        await sut.FilterAsync(ViewerLogin, [Raw(1, "sha-B")], default);

        requestCount.Should().Be(2);
    }

    [Fact]
    public async Task Empty_input_returns_empty()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, "[]");
        });
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [], default);

        result.Should().BeEmpty();
        requestCount.Should().Be(0);
    }

    [Fact]
    public async Task Cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // pre-cancelled

        var handler = new FakeHttpMessageHandler(_ =>
        {
            cts.Token.ThrowIfCancellationRequested();
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "old"));
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "sha1")], cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task Pr_without_head_sha_is_skipped_silently()
    {
        // candidate.HeadSha is empty → PR not in result; no HTTP calls
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, ReviewsResponse(ViewerLogin, "sha"));
        });
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "")], default);

        result.Should().BeEmpty();
        requestCount.Should().Be(0);
    }

    [Fact]
    public async Task FetchLastReviewShaAsync_throws_RateLimitExceededException_on_429_with_RetryAfter()
    {
        // pulls/{n}/reviews returns 429 with Retry-After: 20. Without an explicit
        // 429 check the response would flow into EnsureSuccessStatusCode() and
        // surface as a generic HttpRequestException — the poller's Retry-After-aware
        // handler never fires. Spec § 10 requires Retry-After honored on every 429.
        var handler = new FakeHttpMessageHandler(_ =>
        {
            var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests)
            {
                Content = new StringContent("{}", Encoding.UTF8, "application/json"),
            };
            resp.Headers.Add("Retry-After", "20");
            return resp;
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        var ex = (await act.Should().ThrowAsync<RateLimitExceededException>()).Which;
        ex.RetryAfter.Should().Be(TimeSpan.FromSeconds(20));
    }

    [Fact]
    public async Task Concurrency_capped_at_eight()
    {
        // Track in-flight count; assert max never exceeds the documented cap.
        var inFlight = 0;
        var maxObserved = 0;
        var inFlightLock = new object();

        var handler = new FakeHttpMessageHandler(req =>
        {
            // synchronous spike: increment, snapshot, sleep briefly, decrement.
            // The handler is sync (Task.FromResult), so multiple parallel callers
            // overlap inside the bookkeeping window before responding.
            lock (inFlightLock)
            {
                inFlight++;
                if (inFlight > maxObserved) maxObserved = inFlight;
            }
            // tiny stall so the parallel callers have a chance to overlap
            Thread.Sleep(10);
            lock (inFlightLock) inFlight--;

            var body = ReviewsResponse("viewer", "old-sha");
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        });
        var sut = BuildSut(handler);

        // 20 distinct candidates so we exceed the cap by a wide margin
        var candidates = Enumerable.Range(1, 20)
            .Select(n => Raw(n, headSha: $"head-{n}"))
            .ToList();

        await sut.FilterAsync("viewer", candidates, default);

        maxObserved.Should().BeLessThanOrEqualTo(8,
            "the SemaphoreSlim cap of 8 must hold under load");
    }

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

    [Fact]
    public async Task Most_recent_review_on_page_2_is_used_not_page_1()
    {
        // Reviews are ascending: page 1 holds the OLDER review (at "old"), page 2 the NEWER
        // (at "head"). The viewer's latest review IS at head ⇒ PR is excluded. The single-page
        // bug would read page-1 "old" != head ⇒ wrongly include the PR.
        var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""";
        var page2 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" } ]""";
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
        var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""";
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
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]
            """;
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", page1);
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().ContainSingle();
    }

    [Fact]
    public async Task Page_cap_is_honored_and_does_not_loop_forever()
    {
        // 11 scripted pages, each with a rel="next" → the walk must stop at MaxReviewPages (10)
        // and return without throwing or over-calling.
        var pages = Enumerable.Range(1, 11)
            .Select(_ => $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" } ]""")
            .ToArray();
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", pages);
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        await act.Should().NotThrowAsync();
        handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(10);
    }

    [Fact]
    public async Task Most_recent_by_submitted_at_wins_over_array_position()
    {
        // array-FIRST review is the NEWER one (at the current head); array-LAST is OLDER.
        // The old array-last rule would pick "old" != head ⇒ wrongly include. The new rule
        // picks the max-submitted_at review ("head") == head ⇒ correctly exclude.
        var body = $$"""
            [
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" },
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" }
            ]
            """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().BeEmpty("the newest review by submitted_at is at the current head");
    }

    [Fact]
    public async Task Latest_by_submitted_at_with_null_commit_id_falls_back_to_prior()
    {
        // The newest review (by submitted_at) has commit_id: null → skipped; selection falls
        // back to the older review at "old". PR head "new" != "old" ⇒ PR included (decision A).
        var body = $$"""
            [
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" },
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": null,  "submitted_at": "2020-02-01T00:00:00Z" }
            ]
            """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

        result.Should().ContainSingle("the null-commit_id newest review is skipped; best falls back to 'old' != head");
    }

    [Fact]
    public async Task Pending_review_with_null_submitted_at_is_skipped_cleanly_no_malformed_log()
    {
        // The pending review carries a non-null commit_id "head" (load-bearing: a fully-pending
        // review with commit_id null would be skipped at the commit_id gate before the kind
        // check). Its submitted_at is a literal JSON null. It must be excluded by the ValueKind
        // gate as a normal `continue` — NOT thrown-and-caught as a malformed item. best falls
        // back to "old" != head ⇒ PR included; and no ReviewItemSkipped ("malformed JSON shape")
        // log is emitted.
        var log = new CapturingLogger<GitHubAwaitingAuthorFilter>();
        var body = $$"""
            [
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" },
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": null }
            ]
            """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
        var sut = BuildSut(handler, log);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().ContainSingle("pending review skipped; best falls back to 'old' != head");
        log.Entries.Should().NotContain(
            e => e.Message.Contains("malformed JSON shape", StringComparison.Ordinal),
            "a JSON-null submitted_at must be a clean skip, not a malformed-item log");
    }

    [Fact]
    public async Task Newer_review_on_page1_wins_over_older_on_page2_by_submitted_at()
    {
        // Page 1 holds the NEWER review (at head); page 2 the OLDER (at old sha). The running
        // best must be the max-by-submitted_at across BOTH pages ⇒ best == head ⇒ PR excluded.
        var page1 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "head", "submitted_at": "2020-02-01T00:00:00Z" } ]""";
        var page2 = $$"""[ { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old",  "submitted_at": "2020-01-01T00:00:00Z" } ]""";
        var handler = new PaginatedFakeHandler()
            .RouteJson("/repos/acme/api/pulls/1/reviews", page1, page2);
        var sut = BuildSut(handler);

        var result = await sut.FilterAsync(ViewerLogin, [Raw(1, "head")], default);

        result.Should().BeEmpty("the page-1 review is newest by submitted_at and is at head");
        handler.CallCountFor("/repos/acme/api/pulls/1/reviews").Should().Be(2);
    }

    [Fact]
    public async Task Malformed_submitted_at_string_skips_one_review_scan_continues()
    {
        // First review: non-null commit_id "x" (so it passes the commit_id gate) + a non-date
        // STRING submitted_at (passes the ValueKind gate, throws FormatException at parse) →
        // skipped via the malformed-item guard. Second review valid ⇒ best = "old" != head.
        var body = $$"""
            [
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "x",   "submitted_at": "not-a-date" },
              { "user": { "login": "{{ViewerLogin}}" }, "commit_id": "old", "submitted_at": "2020-01-01T00:00:00Z" }
            ]
            """;
        var handler = new FakeHttpMessageHandler(_ => Respond(HttpStatusCode.OK, body));
        var sut = BuildSut(handler);

        var act = async () => await sut.FilterAsync(ViewerLogin, [Raw(1, "new")], default);

        var result = (await act.Should().NotThrowAsync()).Which;
        result.Should().ContainSingle("malformed review skipped; best = 'old' != head");
    }
}
