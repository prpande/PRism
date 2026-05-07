using System.Diagnostics;
using System.Net;
using FluentAssertions;
using PRism.Core;
using PRism.Core.Contracts;
using PRism.GitHub.Tests.TestHelpers;
using Xunit;

namespace PRism.GitHub.Tests;

public class GitHubReviewServiceTimelineTests
{
    private static IReviewService NewService(HttpMessageHandler handler)
    {
        var factory = new FakeHttpClientFactory(handler, new Uri("https://api.github.com/"));
        return new GitHubReviewService(factory, () => Task.FromResult<string?>("ghp_test"), "https://github.com");
    }

    private static string GraphQLTimeline(int commitCount, int forcePushCount = 0, int reviewCount = 0)
    {
        var t0 = DateTimeOffset.Parse("2026-01-01T00:00:00Z", System.Globalization.CultureInfo.InvariantCulture);
        var commitNodes = string.Join(",", Enumerable.Range(0, commitCount).Select(i =>
            $"{{\"__typename\":\"PullRequestCommit\",\"commit\":{{\"oid\":\"c{i:D3}\",\"committedDate\":\"{t0.AddSeconds(i * 60):o}\",\"message\":\"msg {i}\",\"additions\":1,\"deletions\":0}}}}"));
        var fpNodes = string.Join(",", Enumerable.Range(0, forcePushCount).Select(i =>
            $"{{\"__typename\":\"HeadRefForcePushedEvent\",\"beforeCommit\":{{\"oid\":\"before{i}\"}},\"afterCommit\":{{\"oid\":\"after{i}\"}},\"createdAt\":\"{t0.AddSeconds(1000 + i * 60):o}\"}}"));
        var revNodes = string.Join(",", Enumerable.Range(0, reviewCount).Select(i =>
            $"{{\"__typename\":\"PullRequestReview\",\"submittedAt\":\"{t0.AddSeconds(2000 + i * 60):o}\"}}"));
        var allNodes = string.Join(",", new[] { commitNodes, fpNodes, revNodes }.Where(s => s.Length > 0));
        return "{\"data\":{\"repository\":{\"pullRequest\":{" +
               "\"comments\":{\"nodes\":[]}," +
               $"\"timelineItems\":{{\"nodes\":[{allNodes}]}}" +
               "}}}}";
    }

    private static string CommitFilesJson(int additions = 1, int deletions = 0, params string[] files)
    {
        var fs = files.Length == 0 ? new[] { "src/F.cs" } : files;
        var fileEls = string.Join(",", fs.Select(f =>
            $"{{\"filename\":\"{f}\",\"additions\":{additions},\"deletions\":{deletions},\"status\":\"modified\"}}"));
        return $"{{\"sha\":\"x\",\"files\":[{fileEls}]}}";
    }

    [Fact]
    public async Task GetTimelineAsync_skips_per_commit_fanout_above_cap()
    {
        // SkipJaccardAboveCommitCount = 100 default. 150 > 100 → fan-out skipped.
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = GraphQLTimeline(commitCount: 150),
            RestRoute = _ => (HttpStatusCode.OK, CommitFilesJson()),
        };

        var input = await NewService(handler).GetTimelineAsync(
            new PrReference("o", "r", 1), CancellationToken.None);

        input.Commits.Should().HaveCount(150);
        input.Commits.Should().AllSatisfy(c => c.ChangedFiles.Should().BeNull(
            because: "above 100 commits, the per-commit REST fan-out is skipped"));
        handler.PerCommitFetchCount.Should().Be(0);
    }

    [Fact]
    public async Task GetTimelineAsync_runs_per_commit_fanout_below_cap()
    {
        // 30 < 100 → fan-out runs; every commit gets ChangedFiles populated.
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = GraphQLTimeline(commitCount: 30),
            RestRoute = _ => (HttpStatusCode.OK, CommitFilesJson(files: new[] { "src/F.cs", "src/G.cs" })),
        };

        var input = await NewService(handler).GetTimelineAsync(
            new PrReference("o", "r", 1), CancellationToken.None);

        input.Commits.Should().HaveCount(30);
        input.Commits.Should().AllSatisfy(c => c.ChangedFiles.Should().NotBeNull().And.HaveCount(2));
        handler.PerCommitFetchCount.Should().Be(30);
    }

    [Fact]
    public async Task GetTimelineAsync_paces_inter_batch_with_100ms_delay()
    {
        // Concurrency cap = 8, inter-batch pace = 100ms. 24 commits → 3 batches → ≥ 2 pauses → ≥ 200ms.
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = GraphQLTimeline(commitCount: 24),
            RestRoute = _ => (HttpStatusCode.OK, CommitFilesJson()),
        };

        var sw = Stopwatch.StartNew();
        var input = await NewService(handler).GetTimelineAsync(
            new PrReference("o", "r", 1), CancellationToken.None);
        sw.Stop();

        input.Commits.Should().HaveCount(24);
        sw.ElapsedMilliseconds.Should().BeGreaterThan(180,
            because: "two inter-batch 100ms pauses across three batches");
    }

    [Fact]
    public async Task Per_commit_fanout_4xx_ratchets_session_degraded_and_skips_remaining()
    {
        // 4xx on any per-commit fetch: that commit's ChangedFiles = null, session marked
        // degraded, ALL remaining batches resolve commits to null without issuing requests.
        // Spec § 6.4 + § 10.1. We force the 5th per-commit response to 403.
        // With concurrency cap 8, the 5th call lands inside batch 1 (commits 0..7).
        // Batch 1 still completes its 8 in-flight calls (we can't cancel mid-batch);
        // batches 2 and 3 (commits 8..15, 16..23, 24..29) are skipped entirely.
        // Expected: PerCommitFetchCount == 8 (batch 1 only); commits 8..29 are all null.
        var calls = 0;
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = GraphQLTimeline(commitCount: 30),
            RestRoute = path =>
            {
                var thisCall = Interlocked.Increment(ref calls);
                if (thisCall == 5) return (HttpStatusCode.Forbidden, "{\"message\":\"rate limit\"}");
                return (HttpStatusCode.OK, CommitFilesJson());
            },
        };

        var input = await NewService(handler).GetTimelineAsync(
            new PrReference("o", "r", 1), CancellationToken.None);

        input.Commits.Should().HaveCount(30);
        handler.PerCommitFetchCount.Should().Be(8,
            because: "the 4xx ratchets degraded after batch 1's 8 in-flight calls; batches 2 and 3 are skipped");
        input.Commits.Skip(8).Should().AllSatisfy(c => c.ChangedFiles.Should().BeNull(
            because: "every commit beyond the failure point is degraded (no fan-out issued)"));
    }

    [Fact]
    public async Task GetTimelineAsync_collects_force_push_events()
    {
        var handler = new GraphQLPlusRestHandler
        {
            GraphQLBody = GraphQLTimeline(commitCount: 5, forcePushCount: 1),
            RestRoute = _ => (HttpStatusCode.OK, CommitFilesJson()),
        };

        var input = await NewService(handler).GetTimelineAsync(
            new PrReference("o", "r", 1), CancellationToken.None);

        input.ForcePushes.Should().HaveCount(1);
        input.ForcePushes[0].BeforeSha.Should().Be("before0");
        input.ForcePushes[0].AfterSha.Should().Be("after0");
    }
}
