using FluentAssertions;
using PRism.Core.Config;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Iterations;
using PRism.Core.PrDetail;
using Xunit;

namespace PRism.Core.Tests.PrDetail;

// #566: PrDetailLoader must evict its snapshot immediately on a PrLifecycleChanged event
// (close / reopen / mark-ready / convert-to-draft). Like a comment post, a lifecycle write
// moves no head SHA, so the (prRef, headSha, generation) key alone re-serves stale detail;
// eviction here mirrors the SingleCommentPostedBusEvent / RootCommentPostedBusEvent pattern.
public class PrDetailLoaderPrLifecycleTests
{
    private static readonly PrReference Pr1 = new("owner", "repo", 1);

    private static PrDetailDto MakeDetail(string headSha = "head1", string baseSha = "base1") =>
        new(
            Pr: new Pr(
                Reference: Pr1,
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
                OpenedAt: DateTimeOffset.UtcNow,
                MergedAt: null),
            ClusteringQuality: ClusteringQuality.Ok,
            Iterations: null,
            Commits: Array.Empty<CommitDto>(),
            RootComments: Array.Empty<IssueCommentDto>(),
            ReviewComments: Array.Empty<ReviewThreadDto>(),
            TimelineCapHit: false,
            ViewerReview: null);

    private static ClusteringInput MakeTimeline(int commitCount) =>
        new(
            Commits: Enumerable.Range(0, commitCount)
                .Select(i => new ClusteringCommit(
                    Sha: $"c{i:D3}",
                    CommittedDate: DateTimeOffset.UtcNow.AddSeconds(i * 60),
                    Message: $"commit {i}",
                    Additions: 10,
                    Deletions: 1,
                    ChangedFiles: new[] { $"file{i}.cs" }))
                .ToArray(),
            ForcePushes: Array.Empty<ClusteringForcePush>(),
            ReviewEvents: Array.Empty<ClusteringReviewEvent>(),
            AuthorPrComments: Array.Empty<ClusteringAuthorComment>());

    private static PrDetailLoader MakeLoader(
        FakePrDetailReviewService review,
        IReviewEventBus? bus = null) =>
        new(
            review,
            new RecordingClusterer(new List<string>()),
            new IterationClusteringCoefficients(),
            new FakeConfigStore(),
            bus ?? new ReviewEventBus());

    [Fact]
    public async Task PrLifecycleChanged_evicts_the_snapshot_despite_unchanged_headSha()
    {
        // #566: a lifecycle write (close/reopen/draft toggle) moves no head SHA, so the
        // (prRef, headSha, generation) cache key alone re-serves stale detail. The loader
        // must subscribe to PrLifecycleChanged and evict the snapshot immediately, mirroring
        // the SingleCommentPostedBusEvent and RootCommentPostedBusEvent subscriptions.
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "base1", "MERGEABLE", PrState.Open, 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);
        loader.TryGetCachedSnapshot(Pr1).Should().NotBeNull();

        bus.Publish(new PrLifecycleChanged(Pr1));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .BeNull("a lifecycle change evicts the head-SHA-keyed snapshot so the reload re-fetches fresh detail");
    }

    [Fact]
    public async Task PrLifecycleChanged_for_other_prRef_does_not_evict_this_snapshot()
    {
        // Eviction is scoped to evt.PrRef — a lifecycle event on a different PR must not drop
        // this PR's cached snapshot (which would 422 /file & /viewed for no reason).
        var review = new FakePrDetailReviewService();
        review.DefaultPollResponse = new ActivePrPollSnapshot("head1", "base1", "MERGEABLE", PrState.Open, 0, 0);
        review.DefaultDetailResponse = MakeDetail(headSha: "head1");
        review.DefaultTimelineResponse = MakeTimeline(5);
        var bus = new ReviewEventBus();
        var loader = MakeLoader(review, bus: bus);

        await loader.LoadAsync(Pr1, CancellationToken.None);

        bus.Publish(new PrLifecycleChanged(new PrReference("owner", "repo", 2)));

        loader.TryGetCachedSnapshot(Pr1).Should()
            .NotBeNull("a different PR's lifecycle change must not evict this PR's snapshot");
    }
}
