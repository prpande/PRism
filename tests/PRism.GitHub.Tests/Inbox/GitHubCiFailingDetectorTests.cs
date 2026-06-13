using System.Net;
using System.Text;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Inbox;
using PRism.Core.Time;
using PRism.GitHub.Inbox;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests.Inbox;

public sealed class GitHubCiFailingDetectorTests
{
    private static RawPrInboxItem Raw(int n, string headSha = "sha", string repo = "acme/api")
    {
        var parts = repo.Split('/');
        return new RawPrInboxItem(
            new PrReference(parts[0], parts[1], n),
            $"PR #{n}", "author", repo,
            DateTimeOffset.UtcNow, DateTimeOffset.UtcNow,
            0, 0, 0, headSha, 1, 0);
    }

    private static HttpResponseMessage Respond(HttpStatusCode code, string body)
        => JsonHttpResponse.Create(code, body);

    private static GitHubCiFailingDetector BuildSut(FakeHttpMessageHandler handler, IClock? clock = null) =>
        new(new FakeHttpClientFactory(handler, new Uri("https://api.github.com/")),
            () => Task.FromResult<string?>("t"),
            clock ?? new MutableClock());

    private static FakeHttpMessageHandler RouterHandler(string checkRunsBody, string statusBody)
        => new(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, checkRunsBody);
            if (req.RequestUri!.AbsoluteUri.Contains("/status", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, statusBody);
            return Respond(HttpStatusCode.NotFound, "{}");
        });

    private const string AllPassingCheckRuns = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "success" },
            { "name": "ci/test",  "status": "completed", "conclusion": "success" }
          ]
        }
        """;

    // "success" combined-status with NO registered legacy statuses (empty statuses, no
    // total_count) → HasRegisteredStatuses=false → contributes None (the #286 "no legacy
    // CI" case), NOT Passing. Named for what it CONTRIBUTES, not the wire "state": tests
    // that use this as the status source get their Passing from the check-runs source.
    private const string SuccessNoLegacyStatus = """{ "state": "success", "statuses": [] }""";

    private const string FailingCheckRun = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "success" },
            { "name": "ci/test",  "status": "completed", "conclusion": "failure" }
          ]
        }
        """;

    private const string FailureStatus = """{ "state": "failure", "statuses": [] }""";
    private const string ErrorStatus = """{ "state": "error", "statuses": [] }""";

    private const string InProgressCheckRun = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "in_progress", "conclusion": null }
          ]
        }
        """;

    private const string EmptyCheckRuns = """{ "check_runs": [] }""";

    // All check-runs COMPLETED but with non-success conclusions (skipped/neutral) — the
    // common path-filtered / matrix-excluded case. Not failing, not pending, not success.
    private const string SkippedCheckRuns = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "skipped" },
            { "name": "ci/lint",  "status": "completed", "conclusion": "neutral" }
          ]
        }
        """;

    // A real success alongside a skipped run — the success is still a positive signal.
    private const string SuccessAndSkippedCheckRuns = """
        {
          "check_runs": [
            { "name": "ci/build", "status": "completed", "conclusion": "success" },
            { "name": "ci/lint",  "status": "completed", "conclusion": "skipped" }
          ]
        }
        """;

    // GitHub's combined-status endpoint reports state="pending" with total_count=0 when no
    // legacy commit statuses are registered — the default for an Actions-only or no-CI PR (#286).
    private const string EmptyPendingStatus = """{ "state": "pending", "total_count": 0, "statuses": [] }""";

    // A genuinely in-progress legacy commit status (registered context, total_count > 0).
    private const string RegisteredPendingStatus = """
        { "state": "pending", "total_count": 1, "statuses": [ { "context": "ci/legacy", "state": "pending" } ] }
        """;

    // A pending status whose total_count is absent but whose statuses array is non-empty —
    // exercises HasRegisteredStatuses' array fallback (the OR's second operand).
    private const string PendingStatusNoTotalCount = """
        { "state": "pending", "statuses": [ { "context": "ci/legacy", "state": "pending" } ] }
        """;

    // A registered legacy commit status that has SUCCEEDED (total_count > 0, success).
    // Distinct from SuccessNoLegacyStatus, whose empty statuses array means "no legacy
    // statuses registered" → None under #286 semantics.
    private const string SuccessRegisteredStatus = """
        { "state": "success", "total_count": 1, "statuses": [ { "context": "ci/legacy", "state": "success" } ] }
        """;

    [Fact]
    public async Task Failing_check_run_marks_failing()
    {
        var handler = RouterHandler(FailingCheckRun, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task Failure_status_marks_failing()
    {
        var handler = RouterHandler(AllPassingCheckRuns, FailureStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task Error_status_marks_failing()
    {
        var handler = RouterHandler(AllPassingCheckRuns, ErrorStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Failing);
    }

    [Fact]
    public async Task All_passing_marks_passing()
    {
        // All check-runs completed successfully and the combined status is success
        // with no registered legacy statuses → (Passing, None) → Passing (#264).
        var handler = RouterHandler(AllPassingCheckRuns, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact]
    public async Task Empty_check_runs_with_no_statuses_marks_none()
    {
        // An EMPTY check_runs array is "no checks", NOT "all checks passed". The
        // detector only marks Passing when a run completed with conclusion "success"
        // (anySuccess) — an empty array has none, so a no-CI PR stays None (the
        // passing-side analogue of the #286 false-amber bug). SuccessNoLegacyStatus is
        // success+empty-statuses → None, so both sources are None → None.
        var handler = RouterHandler(EmptyCheckRuns, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task All_skipped_or_neutral_check_runs_mark_none()
    {
        // #264 (adversarial-review finding): completed-but-not-success conclusions
        // (skipped / neutral / action_required / stale) are NOT a positive signal. A PR
        // whose checks were all skipped (path filters, matrix exclusions) must not show a
        // false green tick — only conclusion="success" makes Passing. Both sources None → None.
        var handler = RouterHandler(SkippedCheckRuns, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Success_among_skipped_check_runs_marks_passing()
    {
        // A real success is a positive signal even when other runs were skipped — the
        // anySuccess gate must not require ALL runs to succeed, only at least one. (#264)
        var handler = RouterHandler(SuccessAndSkippedCheckRuns, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact]
    public async Task All_pending_marks_pending()
    {
        // Both sources genuinely pending: an in-progress check-run and a registered
        // (total_count > 0) pending legacy status. Uses RegisteredPendingStatus rather
        // than a bare empty-statuses pending so the combined-status source really does
        // contribute Pending under the #286 semantics (not just the check-run).
        var handler = RouterHandler(InProgressCheckRun, RegisteredPendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Combined_status_pending_with_no_registered_statuses_marks_none()
    {
        // #286: GitHub's combined-status endpoint returns state="pending" when NO legacy
        // commit statuses are registered (Actions-only or no-CI PRs). That is "no checks
        // configured", not "checks in progress". With empty check-runs too, the PR has no
        // CI at all → None (no amber dot). Pre-#286 this misclassified as Pending.
        var handler = RouterHandler(EmptyCheckRuns, EmptyPendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Combined_status_pending_with_registered_statuses_marks_pending()
    {
        // A genuinely in-progress legacy status (total_count > 0) is real Pending — the
        // #286 fix must not regress this: only EMPTY combined-status pending is demoted.
        var handler = RouterHandler(EmptyCheckRuns, RegisteredPendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Combined_status_pending_with_statuses_but_no_total_count_marks_pending()
    {
        // HasRegisteredStatuses' array fallback: when total_count is absent, a non-empty
        // statuses array still counts as a registered context → Pending. Validates the
        // positive path of the OR (the branch the all-empty case at line above can't reach).
        var handler = RouterHandler(EmptyCheckRuns, PendingStatusNoTotalCount);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Combined_status_success_with_registered_statuses_marks_passing()
    {
        // A registered legacy status that succeeded is a positive signal. With empty
        // check-runs, (None, Passing) → Passing (#264).
        var handler = RouterHandler(EmptyCheckRuns, SuccessRegisteredStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
    }

    [Fact]
    public async Task Combined_status_success_with_no_registered_statuses_marks_none()
    {
        // #286 reinforcement on the success branch: state="success" with NO registered
        // statuses (empty statuses, no total_count) is "no legacy CI configured", not a
        // positive signal. With empty check-runs too → None (no false green tick).
        var handler = RouterHandler(EmptyCheckRuns, SuccessNoLegacyStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Passing_checks_with_pending_status_marks_pending()
    {
        // Precedence: Pending outranks Passing. Green check-runs + a genuinely
        // in-progress legacy status → (Passing, Pending) → Pending (#264).
        var handler = RouterHandler(AllPassingCheckRuns, RegisteredPendingStatus);
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items[0].Ci.Should().Be(CiStatus.Pending);
    }

    [Fact]
    public async Task Passing_while_other_source_degraded_is_not_cached()
    {
        // #264/#213: a Passing observed while the OTHER source 5xx'd must NOT be cached —
        // the unread source could hide a Failing. The next tick must re-probe and reflect
        // the recovered status (here the combined-status endpoint recovers to failure).
        var recovered = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            // /status: degraded (503) first tick, then recovers to a failure status.
            return recovered
                ? Respond(HttpStatusCode.OK, FailureStatus)
                : Respond(HttpStatusCode.ServiceUnavailable, "{}");
        });
        var sut = BuildSut(handler);

        var first = await sut.DetectAsync([Raw(1)], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing,
            "checks are green and the degraded status source contributes nothing this tick");

        recovered = true;
        var second = await sut.DetectAsync([Raw(1)], default);
        second.Items[0].Ci.Should().Be(CiStatus.Failing,
            "the degraded Passing must not have been cached — the recovered tick re-probes and sees the failure");
    }

    [Fact]
    public async Task Cache_hit_skips_http()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "sha-A");
        await sut.DetectAsync([candidate], default);
        var countAfterFirst = requestCount;
        await sut.DetectAsync([candidate], default);

        // First call: 2 HTTP requests (check-runs + status); second call: zero new requests
        countAfterFirst.Should().Be(2);
        requestCount.Should().Be(2, "second DetectAsync call for same (pr, sha) must hit the cache");
    }

    [Fact]
    public async Task Cache_invalidates_on_head_sha_change()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        await sut.DetectAsync([Raw(1, "sha-A")], default);
        await sut.DetectAsync([Raw(1, "sha-B")], default);

        // Two distinct (prRef, headSha) keys → two full probe cycles (2 HTTP calls each)
        requestCount.Should().Be(4, "different headSha keys must each trigger a fresh probe");
    }

    [Fact]
    public async Task Degraded_result_is_not_cached_and_reprobes_next_call()
    {
        // #213: a transient non-2xx degrades to None but must NOT be cached — otherwise
        // the None is pinned for the same (prRef, headSha) until the head SHA changes,
        // contradicting the "recovers next tick" contract. The next call must re-probe
        // and reflect the recovered status (here: Failing).
        var recovered = false;
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? (recovered
                    ? Respond(HttpStatusCode.OK, FailingCheckRun)
                    : Respond(HttpStatusCode.ServiceUnavailable, "{}"))
                : Respond(HttpStatusCode.OK, SuccessNoLegacyStatus));
        var sut = BuildSut(handler);

        var first = await sut.DetectAsync([Raw(1)], default);
        first.Items[0].Ci.Should().Be(CiStatus.None, "the 5xx tick degrades to None");

        recovered = true;
        var second = await sut.DetectAsync([Raw(1)], default);
        second.Items[0].Ci.Should().Be(CiStatus.Failing,
            "the degraded None must not have been cached — the recovered tick re-probes");
    }

    [Fact]
    public async Task Definitive_failing_is_cached_even_when_other_source_degraded()
    {
        // #213 follow-up: a Failing observed from check-runs is definitive — a transient 5xx
        // on the combined-status endpoint can't un-fail it. So the result must be (a) Failing
        // and (b) cached, NOT flagged degraded and re-probed. Marking a definitive Failing as
        // degraded (because the OTHER source degraded) contradicts ProbeAsync's contract
        // ("A definitively-observed Failing is never degraded") and causes needless GitHub
        // API load by re-probing a stable failing status every tick.
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            return req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, FailingCheckRun)
                : Respond(HttpStatusCode.ServiceUnavailable, "{}");
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "sha-A");
        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Failing,
            "a failing check-run is definitive regardless of the combined-status endpoint's health");
        var countAfterFirst = requestCount;

        await sut.DetectAsync([candidate], default);

        countAfterFirst.Should().Be(2);
        requestCount.Should().Be(2,
            "a definitive Failing must be cached, not flagged degraded and re-probed, even when combined-status 5xx'd");
    }

    [Fact]
    public async Task Concurrency_capped_at_eight()
    {
        var inFlight = 0;
        var maxObserved = 0;
        var inFlightLock = new object();

        var handler = new FakeHttpMessageHandler(req =>
        {
            var isChecks = req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal);
            if (isChecks)
            {
                lock (inFlightLock)
                {
                    inFlight++;
                    if (inFlight > maxObserved) maxObserved = inFlight;
                }
                Thread.Sleep(10);
                lock (inFlightLock) inFlight--;
            }
            var body = isChecks ? "{\"check_runs\":[]}" : "{\"state\":\"success\"}";
            return new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body, Encoding.UTF8, "application/json"),
            };
        });
        var sut = BuildSut(handler);

        var candidates = Enumerable.Range(1, 20)
            .Select(n => Raw(n, headSha: $"head-{n}"))
            .ToList();

        await sut.DetectAsync(candidates, default);

        maxObserved.Should().BeLessThanOrEqualTo(8,
            "the SemaphoreSlim cap of 8 must hold under load (measured at /check-runs)");
    }

    [Fact]
    public async Task Empty_input_returns_empty()
    {
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(_ =>
        {
            Interlocked.Increment(ref requestCount);
            return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
        });
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([], default);

        result.Items.Should().BeEmpty();
        requestCount.Should().Be(0);
    }

    [Fact]
    public async Task FetchChecksAsync_paginates_when_link_header_present_and_aggregates_failing_across_pages()
    {
        // Page 1: 100 passing check_runs + Link header pointing to page 2.
        // Page 2: 1 failing check_run, no further Link.
        // Without pagination support, the detector would only see page 1 (all passing)
        // and misclassify CI as None. With pagination, the failing run on page 2 is
        // observed and CI must be Failing.
        var passingRuns = string.Join(",",
            Enumerable.Repeat(
                """{ "name": "ci/build", "status": "completed", "conclusion": "success" }""",
                100));
        var page1Body = $$"""{ "check_runs": [{{passingRuns}}] }""";
        const string page2Body = """
            {
              "check_runs": [
                { "name": "ci/matrix-shard-101", "status": "completed", "conclusion": "failure" }
              ]
            }
            """;
        const string nextUrl = "https://api.github.com/repos/acme/api/commits/sha/check-runs?per_page=100&page=2";

        var handler = new FakeHttpMessageHandler(req =>
        {
            var uri = req.RequestUri!.AbsoluteUri;
            if (uri.Contains("/check-runs", StringComparison.Ordinal))
            {
                if (uri.Contains("page=2", StringComparison.Ordinal))
                    return Respond(HttpStatusCode.OK, page2Body);
                var resp = Respond(HttpStatusCode.OK, page1Body);
                resp.Headers.TryAddWithoutValidation(
                    "Link",
                    $"<{nextUrl}>; rel=\"next\", <{nextUrl}>; rel=\"last\"");
                return resp;
            }
            if (uri.Contains("/status", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
            return Respond(HttpStatusCode.NotFound, "{}");
        });
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Failing,
            "a failing check_run on page 2 must be observed via Link-header pagination");
    }

    [Fact]
    public async Task All_passing_first_page_then_degraded_next_page_marks_none_not_passing()
    {
        // #264 (claude[bot] F2): page 1 is all-green (anySuccess) with a Link to page 2;
        // page 2 returns 503. An incomplete read must NOT claim Passing — a not-yet-read
        // page could carry a Failing. The tick degrades to None (not cached) so it re-probes
        // next tick. (Contrast the paginating-Failing test above: Failing IS definitive
        // across a degraded page; Passing is not.)
        var passingRuns = string.Join(",",
            Enumerable.Repeat(
                """{ "name": "ci/build", "status": "completed", "conclusion": "success" }""",
                100));
        var page1Body = $$"""{ "check_runs": [{{passingRuns}}] }""";
        const string nextUrl = "https://api.github.com/repos/acme/api/commits/sha/check-runs?per_page=100&page=2";

        var handler = new FakeHttpMessageHandler(req =>
        {
            var uri = req.RequestUri!.AbsoluteUri;
            if (uri.Contains("/check-runs", StringComparison.Ordinal))
            {
                if (uri.Contains("page=2", StringComparison.Ordinal))
                    return Respond(HttpStatusCode.ServiceUnavailable, "{}");
                var resp = Respond(HttpStatusCode.OK, page1Body);
                resp.Headers.TryAddWithoutValidation("Link", $"<{nextUrl}>; rel=\"next\"");
                return resp;
            }
            if (uri.Contains("/status", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
            return Respond(HttpStatusCode.NotFound, "{}");
        });
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items[0].Ci.Should().Be(CiStatus.None,
            "an incomplete read (page 2 degraded) cannot confirm Passing from page 1's green runs");
        result.Complete.Should().BeFalse("the degraded read must not be cached");
    }

    [Fact]
    public async Task DetectAsync_returns_Complete_false_when_a_probe_degrades()
    {
        // Checks API 403 (fine-grained PAT) → degraded; status 200 success.
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.Forbidden, "{}")
                : Respond(HttpStatusCode.OK, """{"state":"success"}"""));
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync(new[] { Raw(1, "sha1") }, CancellationToken.None);

        result.Complete.Should().BeFalse();
        result.Items.Should().ContainSingle().Which.Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task DetectAsync_returns_Complete_true_when_all_probes_succeed()
    {
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, """{"check_runs":[]}""")
                : Respond(HttpStatusCode.OK, """{"state":"success"}"""));
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync(new[] { Raw(1, "sha1") }, CancellationToken.None);

        result.Complete.Should().BeTrue();
        result.Items.Should().ContainSingle().Which.Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Cancellation_propagates()
    {
        using var cts = new CancellationTokenSource();
        cts.Cancel(); // pre-cancelled

        var handler = new FakeHttpMessageHandler(_ =>
        {
            cts.Token.ThrowIfCancellationRequested();
            return Respond(HttpStatusCode.OK, AllPassingCheckRuns);
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.DetectAsync([Raw(1, "sha1")], cts.Token);

        await act.Should().ThrowAsync<OperationCanceledException>();
    }

    [Fact]
    public async Task FetchChecksAsync_throws_RateLimitExceededException_on_429_with_RetryAfter()
    {
        // /check-runs returns 429 with Retry-After: 45. Without an explicit 429 check
        // the response would flow into EnsureSuccessStatusCode() and surface as a
        // generic HttpRequestException — the poller's Retry-After-aware handler
        // never fires. Spec § 10 requires Retry-After honored on every 429.
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
            {
                var resp = new HttpResponseMessage(HttpStatusCode.TooManyRequests)
                {
                    Content = new StringContent("{}", Encoding.UTF8, "application/json"),
                };
                resp.Headers.Add("Retry-After", "45");
                return resp;
            }
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        var act = async () => await sut.DetectAsync([Raw(1)], default);

        var ex = (await act.Should().ThrowAsync<RateLimitExceededException>()).Which;
        ex.RetryAfter.Should().Be(TimeSpan.FromSeconds(45));
    }

    [Fact]
    public async Task Forbidden_check_runs_degrades_to_none_not_throw()
    {
        // Fine-grained PATs cannot call the Checks API; GitHub returns a non-2xx.
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.Forbidden, "{}")
                : Respond(HttpStatusCode.OK, SuccessNoLegacyStatus));
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Forbidden_combined_status_degrades_to_passing_not_throw()
    {
        // #264: check-runs returned all-passing → Passing; combined-status 403'd → degraded
        // None. ProbeAsync combines: (Passing, None) → Passing (degraded=true, non-cached).
        // Pre-#264 the result was None because there was no Passing status to emit.
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.OK, AllPassingCheckRuns)
                : Respond(HttpStatusCode.Forbidden, "{}"));
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.Passing);
        result.Complete.Should().BeFalse("combined-status 403 → degraded result must not be marked complete");
    }

    [Fact]
    public async Task ServerError_check_runs_degrades_to_none_not_throw()
    {
        // Intentional breadth (#213, spec Decision 1): the guard swallows ANY non-2xx,
        // not just 403. A transient 5xx degrades this PR's CI to None for the tick rather
        // than aborting the whole inbox refresh — locking in the deliberate tradeoff so a
        // future "narrow this to 403" change has to delete this test on purpose. The 429
        // rate-limit branch is tested separately and still throws RateLimitExceededException.
        var handler = new FakeHttpMessageHandler(req =>
            req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal)
                ? Respond(HttpStatusCode.ServiceUnavailable, "{}")
                : Respond(HttpStatusCode.OK, SuccessNoLegacyStatus));
        var sut = BuildSut(handler);

        var result = await sut.DetectAsync([Raw(1)], default);

        result.Items.Should().HaveCount(1);
        result.Items[0].Ci.Should().Be(CiStatus.None);
    }

    [Fact]
    public async Task Pending_is_not_cached_and_advances_to_terminal_next_sweep()
    {
        // #355 Lever 1: a clean (non-degraded) Pending must NOT be pinned. Same (ref, headSha):
        // sweep 1 reads in-progress (Pending), sweep 2 reads passing → sweep 2 must reflect Passing.
        // On main the cached Pending pins and sweep 2 still returns Pending (RED).
        var finished = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, finished ? AllPassingCheckRuns : InProgressCheckRun);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);

        var first = await sut.DetectAsync([Raw(1)], default);
        first.Items[0].Ci.Should().Be(CiStatus.Pending);

        finished = true;
        var second = await sut.DetectAsync([Raw(1)], default);
        second.Items[0].Ci.Should().Be(CiStatus.Passing,
            "a clean Pending must not be cached — the next sweep re-probes and sees the terminal status");
    }

    [Fact]
    public async Task Pending_reprobes_http_each_sweep()
    {
        // A Pending sweep must issue HTTP again next sweep (not served from cache).
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, InProgressCheckRun);
            return Respond(HttpStatusCode.OK, RegisteredPendingStatus);
        });
        var sut = BuildSut(handler);

        var candidate = Raw(1, "sha-A");
        await sut.DetectAsync([candidate], default);
        var afterFirst = requestCount;
        await sut.DetectAsync([candidate], default);

        afterFirst.Should().Be(2);
        requestCount.Should().Be(4, "a Pending result must re-probe next sweep, not hit the cache");
    }

    [Fact]
    public async Task forceReprobe_bypasses_cache_read_and_refreshes_value()
    {
        // #355 Lever 2: a normal call caches Passing; a forceReprobe call ignores the cache and
        // re-reads (now Failing) for the SAME sha, then WRITES the fresh value so a subsequent
        // normal call returns Failing with no new HTTP.
        var failing = false;
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, failing ? FailingCheckRun : AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing);
        var afterFirst = requestCount; // 2

        failing = true;
        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.Failing, "forceReprobe must bypass the cached Passing");
        requestCount.Should().Be(afterFirst + 2, "forceReprobe re-probes both sources");

        var afterForced = requestCount;
        var third = await sut.DetectAsync([candidate], default); // normal, no force
        third.Items[0].Ci.Should().Be(CiStatus.Failing, "the forced reprobe refreshed the cached value");
        requestCount.Should().Be(afterForced, "the refreshed terminal is now served from cache");
    }

    [Fact]
    public async Task forceReprobe_does_not_cache_pending()
    {
        // forceReprobe still honors Lever 1: a forced reprobe returning Pending is not pinned.
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, InProgressCheckRun);
            return Respond(HttpStatusCode.OK, RegisteredPendingStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.Pending);
        var afterForced = requestCount;

        var normal = await sut.DetectAsync([candidate], default);
        normal.Items[0].Ci.Should().Be(CiStatus.Pending);
        requestCount.Should().Be(afterForced + 2, "a forced Pending was not cached — the next sweep re-probes");
    }

    [Fact]
    public async Task forceReprobe_degraded_leaves_existing_cached_terminal()
    {
        // A forced reprobe that degrades (5xx) writes nothing and does NOT evict the prior
        // cached terminal — a transient blip is not evidence the terminal is wrong.
        var degrade = false;
        var handler = new FakeHttpMessageHandler(req =>
        {
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return degrade
                    ? Respond(HttpStatusCode.ServiceUnavailable, "{}")
                    : Respond(HttpStatusCode.OK, AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing);

        degrade = true;
        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.None, "the forced reprobe degraded this sweep");

        degrade = false;
        var normal = await sut.DetectAsync([candidate], default);
        normal.Items[0].Ci.Should().Be(CiStatus.Passing,
            "the degraded forced reprobe did not evict the prior cached terminal");
    }

    [Fact]
    public async Task forceReprobe_nondegraded_pending_evicts_stale_cached_terminal()
    {
        // #355 (Copilot review): a forced reprobe that observes a CLEAN (non-degraded) Pending
        // on a key that still holds a STALE terminal (the same-SHA "Re-run failed jobs" case)
        // must EVICT that terminal. Otherwise Lever 1's "don't cache Pending" leaves the old
        // terminal in place, and the very next NON-forced sweep reads it and flips the dot back
        // after a single render — defeating Lever 2 for the re-run path. With the key evicted,
        // normal sweeps re-probe (Lever 1) until CI goes terminal again, then re-cache.
        // Contrast forceReprobe_degraded_leaves_existing_cached_terminal: a DEGRADED forced
        // reprobe must NOT evict (a transient blip is not evidence the terminal is wrong).
        var phase = "passing"; // passing → pending (re-run started) → passing (re-run finished)
        var requestCount = 0;
        var handler = new FakeHttpMessageHandler(req =>
        {
            Interlocked.Increment(ref requestCount);
            if (req.RequestUri!.AbsoluteUri.Contains("/check-runs", StringComparison.Ordinal))
                return Respond(HttpStatusCode.OK, phase == "pending" ? InProgressCheckRun : AllPassingCheckRuns);
            return Respond(HttpStatusCode.OK, SuccessNoLegacyStatus);
        });
        var sut = BuildSut(handler);
        var candidate = Raw(1, "sha-A");

        // 1) A normal sweep caches the terminal Passing under (ref, sha-A).
        var first = await sut.DetectAsync([candidate], default);
        first.Items[0].Ci.Should().Be(CiStatus.Passing);

        // 2) Same-SHA CI re-run: a forced reprobe (manual Refresh) sees Pending and must
        //    evict the stale cached Passing.
        phase = "pending";
        var forced = await sut.DetectAsync([candidate], default, forceReprobe: true);
        forced.Items[0].Ci.Should().Be(CiStatus.Pending, "the forced reprobe sees the re-run in progress");
        var afterForced = requestCount;

        // 3) A NORMAL (non-forced) sweep must re-probe — proving the stale Passing was evicted,
        //    not served from the cache — and reflect the live Pending. On main (no eviction)
        //    this returns the cached Passing with zero new HTTP (RED).
        var normal = await sut.DetectAsync([candidate], default);
        normal.Items[0].Ci.Should().Be(CiStatus.Pending,
            "the stale cached terminal was evicted, so the normal sweep re-probes and sees Pending");
        requestCount.Should().Be(afterForced + 2,
            "eviction forces the next normal sweep to re-probe both sources, not hit the stale cache");

        // 4) When the re-run finishes, a normal sweep advances to terminal and re-caches it.
        phase = "passing";
        var healed = await sut.DetectAsync([candidate], default);
        healed.Items[0].Ci.Should().Be(CiStatus.Passing, "Lever 1 re-probes Pending each sweep until terminal");
    }

    [Fact]
    public async Task Evicts_absent_pr_cache_entry_observed_on_reinclusion()
    {
        // Count check-runs probes per PR. Frozen default clock ⇒ TTL never expires,
        // so a tick-3 re-probe is attributable to eviction alone, not TTL.
        var perPr = new Dictionary<string, int>();
        var handler = new FakeHttpMessageHandler(req =>
        {
            var path = req.RequestUri!.AbsolutePath;
            if (path.Contains("/check-runs", StringComparison.Ordinal))
            {
                perPr[path] = perPr.TryGetValue(path, out var v) ? v + 1 : 1;
                return Respond(HttpStatusCode.OK, FailingCheckRun);
            }
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
        r1.Items[0].Ci.Should().Be(CiStatus.Failing);

        // Same SHA "re-run": CI flips to in-progress. Advance past the TTL → re-probe picks it up.
        checkRunsBody = InProgressCheckRun;
        clock.Advance(TimeSpan.FromMinutes(3));
        var r2 = await sut.DetectAsync([pr], default);

        r2.Items[0].Ci.Should().Be(CiStatus.Pending, "past the TTL the same-SHA re-run is re-probed");
    }
}
