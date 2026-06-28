using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using Microsoft.Extensions.DependencyInjection;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.GitHub;
using PRism.Web.Tests.TestHelpers;
using Xunit;

namespace PRism.Web.Tests.Endpoints;

// Spec § 6.1 + § 8. Uses PRismWebApplicationFactory + PrDetailFakeReviewService to exercise
// the full endpoint pipeline (routing, model binding, problem-details shaping, JSON
// serialization) without spinning up a real GitHub HTTP layer.
public class PrDetailEndpointsTests
{
    private static PrDetailDto MakeDetail(string headSha = "head1", string baseSha = "base1") =>
        new(
            Pr: new Pr(
                Reference: new PrReference("octo", "repo", 1),
                Title: "Test PR",
                Body: "body",
                Author: "alice",
                State: PrState.Open,
                HeadSha: headSha,
                BaseSha: baseSha,
                HeadBranch: "feat/x",
                BaseBranch: "main",
                Mergeability: "MERGEABLE",
                CiSummary: "passing",
                IsMerged: false,
                IsClosed: false,
                OpenedAt: DateTimeOffset.UtcNow),
            ClusteringQuality: ClusteringQuality.Ok,
            Iterations: null,
            Commits: Array.Empty<CommitDto>(),
            RootComments: Array.Empty<IssueCommentDto>(),
            ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false,
            ViewerReview: null);

    private static ClusteringInput MakeTimeline(int commitCount, string shaPrefix = "c") =>
        new(
            Commits: Enumerable.Range(0, commitCount)
                .Select(i => new ClusteringCommit(
                    Sha: $"{shaPrefix}{i:D3}",
                    CommittedDate: DateTimeOffset.UtcNow.AddSeconds(i * 60),
                    Message: $"commit {i}",
                    Additions: 10,
                    Deletions: 1,
                    ChangedFiles: new[] { $"file{i}.cs" }))
                .ToArray(),
            ForcePushes: Array.Empty<ClusteringForcePush>(),
            ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
            AuthorPrComments: Array.Empty<ClusteringAuthorComment>());

    private static (PRismWebApplicationFactory, PrDetailFakeReviewService) MakeFactory()
    {
        var review = new PrDetailFakeReviewService
        {
            DefaultDetailResponse = MakeDetail(),
            DefaultTimelineResponse = MakeTimeline(5),
        };
        var factory = new PRismWebApplicationFactory { ReviewServiceOverride = review };
        return (factory, review);
    }

    // ---------- GET /api/pr/{owner}/{repo}/{number} ----------

    [Fact]
    public async Task Get_pr_detail_returns_200_with_dto_for_existing_pr()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        // Read as JsonElement — the API wire format uses kebab-case enum values ("ok"/"low")
        // via the host's JsonSerializerOptions; the default ReadFromJsonAsync<T> doesn't apply
        // those options, so structured introspection avoids enum-deserialization tripping.
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("pr").GetProperty("headSha").GetString().Should().Be("head1");
        body.GetProperty("pr").GetProperty("reference").GetProperty("owner").GetString().Should().Be("octo");
        body.GetProperty("pr").GetProperty("reference").GetProperty("repo").GetString().Should().Be("repo");
        body.GetProperty("pr").GetProperty("reference").GetProperty("number").GetInt32().Should().Be(1);
    }

    [Fact]
    public async Task Get_pr_detail_returns_404_problem_when_loader_returns_null()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DefaultDetailResponse = null;   // forces loader to return null

        var resp = await factory.CreateClient().GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.NotFound);
        var body = await resp.Content.ReadAsStringAsync();
        body.Should().Contain("/pr/not-found");
    }

    [Fact]
    public async Task Get_pr_detail_propagates_ClusteringQuality_Ok_with_single_iteration_when_timeline_has_one_commit()
    {
        // Calibration 2026-05-18: single-commit PRs are legitimately "one unit of work" and
        // return Ok + 1 iteration through the strategy's `sorted.Length == 1` arm.
        // DetermineQuality only short-circuits to Low when Commits.Count == 0 now.
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DefaultTimelineResponse = MakeTimeline(1);

        var resp = await factory.CreateClient().GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("clusteringQuality").GetString().Should().Be("ok",
            because: "kebab-case enum wire format per the project's JsonSerializerOptions");
        body.GetProperty("iterations").ValueKind.Should().Be(JsonValueKind.Array);
        body.GetProperty("iterations").GetArrayLength().Should().Be(1);
        body.GetProperty("commits").GetArrayLength().Should().Be(1);
    }

    // ---------- GET /api/pr/{ref}/diff?range=... ----------

    [Fact]
    public async Task Get_diff_returns_200_with_diff_dto_for_valid_range()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DiffFactory = (_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] { new FileChange("src/Foo.cs", FileChangeStatus.Modified, Array.Empty<DiffHunk>()) },
            Truncated: true);
        var client = factory.CreateClient();

        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("truncated").GetBoolean().Should().BeTrue(
            because: "truncation flag must propagate from IPrReader");
        body.GetProperty("files").GetArrayLength().Should().Be(1);
    }

    [Fact]
    public async Task Get_diff_serializes_DiffHunk_with_camelCase_and_body_starts_with_at_at()
    {
        // Pin the wire contract that DiffPane.parseHunkLines depends on:
        //   - hunks[] is non-empty when the backend has a parsed patch
        //   - oldStart/oldLines/newStart/newLines/body are camelCase
        //   - body INCLUDES the @@ header (parseHunkLines reads line numbers from body,
        //     not from oldStart/newStart). A future field rename or contract drift
        //     would compile clean but break the frontend's diff rendering silently.
        var (factory, review) = MakeFactory();
        using var _f = factory;
        var hunkBody = "@@ -1,3 +1,4 @@\n line1\n+inserted\n line2\n line3";
        review.DiffFactory = (_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] {
                new FileChange("src/Foo.cs", FileChangeStatus.Modified,
                    new[] { new DiffHunk(1, 3, 1, 4, hunkBody) })
            },
            Truncated: false);

        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        var resp = await factory.CreateClient().GetAsync(
            new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        var hunk = body.GetProperty("files")[0].GetProperty("hunks")[0];
        hunk.GetProperty("oldStart").GetInt32().Should().Be(1);
        hunk.GetProperty("oldLines").GetInt32().Should().Be(3);
        hunk.GetProperty("newStart").GetInt32().Should().Be(1);
        hunk.GetProperty("newLines").GetInt32().Should().Be(4);
        hunk.GetProperty("body").GetString().Should().StartWith("@@ -1,3 +1,4 @@");
        hunk.GetProperty("body").GetString().Should().Contain("+inserted");
    }

    [Fact]
    public async Task Get_diff_returns_422_diff_missing_range_when_query_param_absent()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;

        var resp = await factory.CreateClient().GetAsync(new Uri("/api/pr/octo/repo/1/diff", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/diff/missing-range");
    }

    [Fact]
    public async Task Get_diff_returns_422_sha_invalid_for_non_git_oid_range()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;

        var resp = await factory.CreateClient().GetAsync(new Uri("/api/pr/octo/repo/1/diff?range=notvalid..alsonot", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/sha/invalid");
    }

    [Fact]
    public async Task Get_diff_returns_422_range_unreachable_when_fetch_throws_RangeUnreachableException()
    {
        // Spec § 5.1: a GC'd / force-pushed range (compare endpoint 404 → service throws
        // RangeUnreachableException) must surface as a TYPED 422 ProblemDetails, NOT an
        // unhandled 500. Drives the fake's diff path to throw the exact exception the real
        // GitHubReviewService.GetDiffAsync throws; the /diff endpoint's catch maps it.
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DiffFactory = (_, _) => throw new RangeUnreachableException("dead-sha", "head");

        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        var resp = await factory.CreateClient().GetAsync(
            new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/diff/range-unreachable");
    }

    [Fact]
    public async Task Get_file_returns_422_sha_invalid_when_sha_is_not_a_git_oid()
    {
        // /file?sha= must be validated consistently with /diff?range=. The endpoint short-
        // circuits the snapshot probe and IPrReader call when the SHA is malformed.
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/file?path=src/Foo.cs&sha=notvalid", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/sha/invalid");
    }

    [Fact]
    public async Task Get_file_returns_422_range_unreachable_when_canonical_diff_fetch_throws()
    {
        // Task 16a made GetOrFetchDiffAsync throw RangeUnreachableException when the
        // canonical base..head range is no longer addressable on GitHub. The /file
        // endpoint's truncation-check branch calls GetOrFetchDiffAsync for paths not in
        // any cached diff; without the catch it propagates as an unhandled 500.
        // This test drives the fake's diff path to throw, ensures the path is NOT in any
        // cached diff (no prior /diff call), and asserts the typed 422 rather than a 500.
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DiffFactory = (_, _) => throw new RangeUnreachableException("dead-base", "dead-head");
        var client = factory.CreateClient();
        // Prime snapshot so the endpoint reaches the truncation-check branch (not /file/snapshot-evicted).
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        // No diff cache primed — path will not be in any cached diff, triggering the
        // canonical GetOrFetchDiffAsync call that throws RangeUnreachableException.
        var validHead = new string('b', 40);

        var resp = await client.GetAsync(
            new Uri($"/api/pr/octo/repo/1/file?path=src/NotInAnyDiff.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/diff/range-unreachable");
    }

    // ---------- GET /api/pr/{ref}/file?path=&sha= ----------

    [Fact]
    public async Task Get_file_returns_200_text_when_path_in_diff()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();

        // Prime the diff cache and snapshot — the /file endpoint requires both.
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/file?path=src/Foo.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadAsStringAsync()).Should().Be("content of src/Foo.cs");
    }

    [Fact]
    public async Task Get_file_returns_422_file_not_in_diff_when_path_absent_and_canonical_diff_not_truncated()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DiffFactory = (_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] { new FileChange("src/Foo.cs", FileChangeStatus.Modified, Array.Empty<DiffHunk>()) },
            Truncated: false);
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot

        var validHead = new string('b', 40);
        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/file?path=src/Bogus.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/file/not-in-diff");
    }

    [Fact]
    public async Task Get_file_returns_422_file_truncation_window_when_path_absent_and_canonical_diff_truncated()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DiffFactory = (_, r) => new DiffDto(
            Range: $"{r.BaseSha}..{r.HeadSha}",
            Files: new[] { new FileChange("src/Foo.cs", FileChangeStatus.Modified, Array.Empty<DiffHunk>()) },
            Truncated: true);
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot

        var validHead = new string('b', 40);
        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/file?path=src/Bogus.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/file/truncation-window");
    }

    [Fact]
    public async Task Get_file_returns_200_when_snapshot_evicted_but_path_in_cached_diff()
    {
        // #510 core fix. A background event (poller head/comment-count change, comment
        // post-now, root-comment post, draft submit) evicts the per-(prRef,headSha,gen)
        // snapshot while the PR is open. The diff memo is content-addressed by SHA and is
        // NOT evicted by that activity, so expanding a file already present in the loaded
        // diff must still serve content — not dead-end with /file/snapshot-evicted.
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot
        // Any valid-OID range primes the diff memo; the range SHAs need not equal the PR's
        // canonical base1/head1 (those aren't valid git OIDs, so /diff would 422 them). The
        // path-in-diff authz gate is sha-agnostic — it matches the path across ALL cached
        // diffs for the prRef regardless of range — which is exactly what keeps it working
        // after the snapshot (and its head SHA) is evicted.
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        // Evict the snapshot exactly as a background ActivePrUpdated/comment/submit event does.
        var prRef = new PrReference("octo", "repo", 1);
        var loader = factory.Services.GetRequiredService<PrDetailLoader>();
        loader.Invalidate(prRef);
        loader.TryGetCachedSnapshot(prRef).Should().BeNull();   // precondition: snapshot is gone

        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/file?path=src/Foo.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.OK);
        (await resp.Content.ReadAsStringAsync()).Should().Be("content of src/Foo.cs");
    }

    [Fact]
    public async Task Get_file_rehydrates_evicted_snapshot_for_path_outside_cached_diff_instead_of_dead_ending()
    {
        // #510. When the path is NOT in any cached diff, classifying it (truncation-window
        // vs not-in-diff) needs the canonical base..head range, which lives on the snapshot.
        // If a background event evicted the snapshot, re-hydrate on demand rather than
        // returning the manual-reload /file/snapshot-evicted dead-end. src/Ghost.cs is absent
        // from the canonical diff (default fake exposes only src/Foo.cs, not truncated).
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot
        var loader = factory.Services.GetRequiredService<PrDetailLoader>();
        loader.Invalidate(new PrReference("octo", "repo", 1));                      // background eviction

        var validHead = new string('b', 40);
        var resp = await client.GetAsync(
            new Uri($"/api/pr/octo/repo/1/file?path=src/Ghost.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        var bodyText = await resp.Content.ReadAsStringAsync();
        bodyText.Should().Contain("/file/not-in-diff");
        bodyText.Should().NotContain("/file/snapshot-evicted");   // the dead-end is gone
    }

    [Fact]
    public async Task Get_file_returns_422_snapshot_evicted_only_when_rehydrate_fails()
    {
        // The /file/snapshot-evicted contract is retained for the genuine failure: the path
        // is outside any cached diff AND re-hydration cannot rebuild the snapshot because the
        // PR no longer exists (GetPrDetail -> null). Nothing is primed, so the
        // path-not-in-cached-diff fallback runs, LoadAsync returns null, and the endpoint
        // surfaces snapshot-evicted.
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.GetPrDetailAsyncOverride = (_, _) => Task.FromResult<PrDetailDto?>(null);
        var client = factory.CreateClient();

        // Use a valid Git OID so the /sha/invalid guard doesn't short-circuit first.
        var validHead = new string('b', 40);
        var resp = await client.GetAsync(
            new Uri($"/api/pr/octo/repo/1/file?path=src/Ghost.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/file/snapshot-evicted");
    }

    [Fact]
    public async Task Get_file_returns_413_when_file_too_large()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.FileContentFactory = (_, _, _) => new FileContentResult(FileContentStatus.TooLarge, null, 6 * 1024 * 1024);
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.GetAsync(new Uri($"/api/pr/octo/repo/1/file?path=src/Foo.cs&sha={validHead}", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.RequestEntityTooLarge);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/file/too-large");
    }

    // ---------- POST /api/pr/{ref}/mark-viewed ----------

    private static IDictionary<string, string> TabHeader(string tabId = "tab-A") =>
        new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId };

    [Fact]
    public async Task Post_mark_viewed_writes_tab_stamp_under_caller_tab_id_and_monotone_LastSeenCommentId()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot

        var resp = await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = "999" },
            TabHeader("tab-A"));

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Verify state.json side-effect: tab-specific stamp + session-flat last-seen.
        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        var session = state.Reviews.Sessions["octo/repo/1"];
        session.TabStamps.Should().ContainKey("tab-A");
        session.TabStamps["tab-A"].HeadSha.Should().Be("head1");
        session.LastSeenCommentId.Should().Be("999");
    }

    [Fact]
    public async Task Post_mark_viewed_returns_422_when_tab_id_header_missing()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/mark-viewed", UriKind.Relative),
            new { headSha = "head1", maxCommentId = (string?)null });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/tab-id-missing");
    }

    [Theory]
    [InlineData("../../etc/passwd")]   // path-traversal-style chars rejected
    [InlineData("tab with space")]     // disallowed char
    [InlineData("")]                   // empty (also caught by IsNullOrEmpty before regex)
    [InlineData("tab/A")]              // slash disallowed
    public async Task Post_mark_viewed_rejects_invalid_tab_id_header(string tabId)
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var resp = await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = (string?)null },
            new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tabId });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/tab-id-missing");
    }

    [Fact]
    public async Task Post_mark_viewed_rejects_tab_id_over_64_chars()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var tooLong = new string('a', 65);

        var resp = await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = (string?)null },
            new Dictionary<string, string> { ["X-PRism-Tab-Id"] = tooLong });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Post_mark_viewed_evicts_oldest_stamp_at_cap_N_8()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        // Seed 8 stamps via real mark-viewed calls (each different tab id). The N=8 cap is
        // enforced at write time; the 9th call evicts the oldest by StampedAtUtc.
        for (int i = 0; i < 8; i++)
        {
            var resp = await client.PostAsJsonWithHeadersAsync(
                "/api/pr/octo/repo/1/mark-viewed",
                new { headSha = "head1", maxCommentId = (string?)null },
                new Dictionary<string, string> { ["X-PRism-Tab-Id"] = $"tab-{i}" });
            resp.StatusCode.Should().Be(HttpStatusCode.NoContent);
            // Spread the timestamps so MinBy(StampedAtUtc) is deterministic — without a delay
            // every stamp can land in the same DateTime.UtcNow tick.
            await Task.Delay(2);
        }

        var ninth = await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = (string?)null },
            new Dictionary<string, string> { ["X-PRism-Tab-Id"] = "tab-NEW" });
        ninth.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        var stamps = state.Reviews.Sessions["octo/repo/1"].TabStamps;
        stamps.Should().HaveCount(8);
        stamps.Should().ContainKey("tab-NEW");
        stamps.Should().NotContainKey("tab-0", "oldest stamp (tab-0) should have been evicted");
    }

    [Fact]
    public async Task Post_mark_viewed_monotone_LastSeenCommentId_does_not_rewind_across_tabs()
    {
        // Cross-tab regression: tab-A advances LastSeenCommentId to 999; tab-B's stale 50 must
        // not regress the high-water (the user-facing unread badge would jump up). Spec § 5.6.
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = "999" },
            TabHeader("tab-A"));
        await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = "50" },
            TabHeader("tab-B"));

        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        state.Reviews.Sessions["octo/repo/1"].LastSeenCommentId.Should().Be("999");
    }

    [Fact]
    public async Task Post_mark_viewed_returns_422_snapshot_evicted_when_snapshot_not_loaded()
    {
        // No prior GET /api/pr/{ref} call — loader has no cached snapshot. Spec § 8 distinguishes
        // /viewed/snapshot-evicted (refetch the PR first) from /viewed/stale-head-sha (head advanced).
        var (factory, _) = MakeFactory();
        using var _f = factory;

        var resp = await factory.CreateClient().PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "head1", maxCommentId = (string?)null },
            TabHeader());

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/snapshot-evicted");
    }

    [Fact]
    public async Task Post_mark_viewed_returns_409_when_headSha_does_not_match_current_snapshot()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // snapshot's HeadSha = "head1"

        var resp = await client.PostAsJsonWithHeadersAsync(
            "/api/pr/octo/repo/1/mark-viewed",
            new { headSha = "stale-head", maxCommentId = (string?)null },
            TabHeader());

        resp.StatusCode.Should().Be(HttpStatusCode.Conflict);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/stale-head-sha");
    }

    // ---------- POST /api/pr/{ref}/files/viewed ----------

    [Fact]
    public async Task Post_files_viewed_returns_204_and_persists_viewed_file()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();

        // Prime snapshot + diff so authz passes.
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path = "src/Foo.cs", headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        state.Reviews.Sessions["octo/repo/1"].ViewedFiles.Should().ContainKey("src/Foo.cs");
    }

    [Theory]
    [InlineData("../etc/passwd")]              // segment equals ".."
    [InlineData("./relative")]                 // segment equals "."
    [InlineData("")]                           // empty path
    [InlineData("/leading-slash.cs")]          // leading "/"
    [InlineData("trailing-slash/")]            // trailing "/"
    [InlineData("back\\slash.cs")]             // backslash
    [InlineData("src//double-slash.cs")]       // empty segment (double-slash)
    public async Task Post_files_viewed_returns_422_for_path_violating_canonicalization_rules(string path)
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path, headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
    }

    [Fact]
    public async Task Post_files_viewed_returns_422_path_too_long_for_path_over_4096_utf8_bytes()
    {
        // Spec § 8: "path > 4096 bytes" (UTF-8 byte count, not C# char count). 2000 CJK chars
        // (3 bytes each in UTF-8) → ~6000 bytes, well over the cap; would have slipped past a
        // naive `body.Path.Length > 4096` check that uses C# UTF-16 code-unit count.
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var longPath = new string('長', 2000);
        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path = longPath, headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/path-too-long");
    }

    [Fact]
    public async Task Post_files_viewed_returns_422_cap_exceeded_when_session_already_has_10000_viewed_files()
    {
        // Spec § 8: 10000-file cap on ReviewSessions[ref].ViewedFiles. Pre-seed state.json with
        // 10000 entries so the next POST hits the cap branch. The test setup writes directly
        // to disk via AppStateStore so the seed survives the WebApplicationFactory boot.
        var (factory, _) = MakeFactory();
        using var _f = factory;

        // PRismWebApplicationFactory.ConfigureWebHost creates DataDir lazily (on first
        // CreateClient call). Force creation up-front so the seed AppStateStore has a dir
        // to write into.
        Directory.CreateDirectory(factory.DataDir);

        // Seed 10000-entry ViewedFiles into state.json before the SUT loads it.
        using (var seedStore = new AppStateStore(factory.DataDir))
        {
            var initial = await seedStore.LoadAsync(CancellationToken.None);
            var viewedFiles = Enumerable.Range(0, 10000)
                .ToDictionary(i => $"seed/file-{i:D5}.cs", _ => "head1");
            var sessions = new Dictionary<string, ReviewSessionState>
            {
                ["octo/repo/1"] = new ReviewSessionState(new Dictionary<string, TabStamp>(), null, null, null, viewedFiles, new List<DraftComment>(), new List<DraftReply>(), null, DraftVerdictStatus.Draft)
            };
            await seedStore.SaveAsync(initial.WithDefaultReviews(initial.Reviews with { Sessions = sessions }), CancellationToken.None);
        }

        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path = "src/Foo.cs", headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/cap-exceeded");
    }

    // #605 item F — a write at the current head prunes ViewedFiles entries recorded at a stale head.
    [Fact]
    public async Task Post_files_viewed_prunes_superseded_sha_entries_on_write()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;

        Directory.CreateDirectory(factory.DataDir);

        // Seed a ViewedFiles map containing a stale-head entry (recorded at "head0", not the current
        // "head1" snapshot head) plus a current-head entry, before the SUT loads it.
        using (var seedStore = new AppStateStore(factory.DataDir))
        {
            var initial = await seedStore.LoadAsync(CancellationToken.None);
            var viewedFiles = new Dictionary<string, string>
            {
                ["src/Stale.cs"] = "head0",   // superseded — must be pruned
                ["src/Kept.cs"] = "head1",    // current head — must survive
            };
            var sessions = new Dictionary<string, ReviewSessionState>
            {
                ["octo/repo/1"] = new ReviewSessionState(new Dictionary<string, TabStamp>(), null, null, null, viewedFiles, new List<DraftComment>(), new List<DraftReply>(), null, DraftVerdictStatus.Draft)
            };
            await seedStore.SaveAsync(initial.WithDefaultReviews(initial.Reviews with { Sessions = sessions }), CancellationToken.None);
        }

        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path = "src/Foo.cs", headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        var viewed = state.Reviews.Sessions["octo/repo/1"].ViewedFiles;
        viewed.Should().ContainKey("src/Foo.cs").And.ContainKey("src/Kept.cs");
        viewed.Should().NotContainKey("src/Stale.cs", "stale-head entries must be pruned on write");
    }

    [Fact]
    public async Task Post_files_viewed_returns_422_when_path_canonicalizes_but_not_in_diff()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));
        var validBase = new string('a', 40);
        var validHead = new string('b', 40);
        await client.GetAsync(new Uri($"/api/pr/octo/repo/1/diff?range={validBase}..{validHead}", UriKind.Relative));

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/files/viewed", UriKind.Relative),
            new { path = "src/Bogus.cs", headSha = "head1", viewed = true });

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/viewed/path-not-in-diff");
    }
}
