using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FluentAssertions;
using PRism.Core.Contracts;
using PRism.Core.Iterations;
using PRism.Core.State;
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
                State: "OPEN",
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
            TimelineCapHit: false);

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
    public async Task Get_pr_detail_propagates_ClusteringQuality_Low_when_timeline_has_one_commit()
    {
        var (factory, review) = MakeFactory();
        using var _f = factory;
        review.DefaultTimelineResponse = MakeTimeline(1);

        var resp = await factory.CreateClient().GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var body = await resp.Content.ReadFromJsonAsync<JsonElement>();
        body.GetProperty("clusteringQuality").GetString().Should().Be("low",
            because: "kebab-case enum wire format per the project's JsonSerializerOptions");
        body.GetProperty("iterations").ValueKind.Should().Be(JsonValueKind.Null);
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
            because: "truncation flag must propagate from IReviewService");
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
    public async Task Get_file_returns_422_sha_invalid_when_sha_is_not_a_git_oid()
    {
        // /file?sha= must be validated consistently with /diff?range=. The endpoint short-
        // circuits the snapshot probe and IReviewService call when the SHA is malformed.
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));

        var resp = await client.GetAsync(new Uri("/api/pr/octo/repo/1/file?path=src/Foo.cs&sha=notvalid", UriKind.Relative));

        resp.StatusCode.Should().Be(HttpStatusCode.UnprocessableEntity);
        (await resp.Content.ReadAsStringAsync()).Should().Contain("/sha/invalid");
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
    public async Task Get_file_returns_422_snapshot_evicted_when_no_snapshot_loaded()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;

        // Use a valid Git OID so the new /sha/invalid guard doesn't short-circuit before
        // the snapshot probe — the snapshot-evicted contract is what this test exercises.
        var validHead = new string('b', 40);
        var resp = await factory.CreateClient().GetAsync(
            new Uri($"/api/pr/octo/repo/1/file?path=src/Foo.cs&sha={validHead}", UriKind.Relative));

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

    [Fact]
    public async Task Post_mark_viewed_returns_204_and_writes_LastViewedHeadSha_and_LastSeenCommentId()
    {
        var (factory, _) = MakeFactory();
        using var _f = factory;
        var client = factory.CreateClient();
        await client.GetAsync(new Uri("/api/pr/octo/repo/1", UriKind.Relative));   // load snapshot

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/mark-viewed", UriKind.Relative),
            new { headSha = "head1", maxCommentId = "999" });

        resp.StatusCode.Should().Be(HttpStatusCode.NoContent);

        // Verify state.json side-effect.
        using var stateStore = new AppStateStore(factory.DataDir);
        var state = await stateStore.LoadAsync(CancellationToken.None);
        var session = state.Reviews.Sessions["octo/repo/1"];
        session.LastViewedHeadSha.Should().Be("head1");
        session.LastSeenCommentId.Should().Be("999");
    }

    [Fact]
    public async Task Post_mark_viewed_returns_422_snapshot_evicted_when_snapshot_not_loaded()
    {
        // No prior GET /api/pr/{ref} call — loader has no cached snapshot. Spec § 8 distinguishes
        // /viewed/snapshot-evicted (refetch the PR first) from /viewed/stale-head-sha (head advanced).
        var (factory, _) = MakeFactory();
        using var _f = factory;

        var resp = await factory.CreateClient().PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/mark-viewed", UriKind.Relative),
            new { headSha = "head1", maxCommentId = (string?)null });

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

        var resp = await client.PostAsJsonAsync(
            new Uri("/api/pr/octo/repo/1/mark-viewed", UriKind.Relative),
            new { headSha = "stale-head", maxCommentId = (string?)null });

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
                ["octo/repo/1"] = new ReviewSessionState(null, null, null, null, viewedFiles, new List<DraftComment>(), new List<DraftReply>(), null, null, DraftVerdictStatus.Draft)
            };
            await seedStore.SaveAsync(initial with { Reviews = initial.Reviews with { Sessions = sessions } }, CancellationToken.None);
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
