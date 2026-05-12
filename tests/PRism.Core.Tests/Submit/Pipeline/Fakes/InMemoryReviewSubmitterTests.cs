using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Submit;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

// Smoke tests for the pipeline-test fake itself: store-and-recall, and one-shot failure injection.
public class InMemoryReviewSubmitterTests
{
    private static PrReference Ref => new("owner", "repo", 1);

    [Fact]
    public async Task BeginPendingReviewAsync_StoresInMemory_AndReturnsId()
    {
        var fake = new InMemoryReviewSubmitter();
        var result = await fake.BeginPendingReviewAsync(Ref, "abc", "summary", CancellationToken.None);
        Assert.NotNull(result.PullRequestReviewId);

        var snapshot = await fake.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        Assert.NotNull(snapshot);
        Assert.Equal(result.PullRequestReviewId, snapshot!.PullRequestReviewId);
        Assert.Equal("abc", snapshot.CommitOid);
    }

    [Fact]
    public async Task FailureInjection_CausesNamedMethodToThrowOnNextCallOnly()
    {
        var fake = new InMemoryReviewSubmitter();
        await fake.BeginPendingReviewAsync(Ref, "abc", "", CancellationToken.None);

        fake.InjectFailure(nameof(IReviewSubmitter.AttachThreadAsync), new HttpRequestException("simulated"));

        var req = new DraftThreadRequest("d", "b", "p", 1, "RIGHT");
        await Assert.ThrowsAsync<HttpRequestException>(() => fake.AttachThreadAsync(Ref, "any", req, CancellationToken.None));

        // Second call succeeds — failure injection is one-shot.
        var result = await fake.AttachThreadAsync(Ref, "any", req, CancellationToken.None);
        Assert.StartsWith("PRRT_", result.PullRequestReviewThreadId, StringComparison.Ordinal);
    }

    [Fact]
    public async Task DeletePendingReviewThreadAsync_RemovesThreadFromSnapshot()
    {
        var fake = new InMemoryReviewSubmitter();
        await fake.BeginPendingReviewAsync(Ref, "abc", "", CancellationToken.None);
        var t = await fake.AttachThreadAsync(Ref, "any", new DraftThreadRequest("d", "b", "p", 1, "RIGHT"), CancellationToken.None);

        await fake.DeletePendingReviewThreadAsync(Ref, t.PullRequestReviewThreadId, CancellationToken.None);

        var snapshot = await fake.FindOwnPendingReviewAsync(Ref, CancellationToken.None);
        Assert.NotNull(snapshot);
        Assert.DoesNotContain(snapshot!.Threads, x => x.PullRequestReviewThreadId == t.PullRequestReviewThreadId);
    }
}
