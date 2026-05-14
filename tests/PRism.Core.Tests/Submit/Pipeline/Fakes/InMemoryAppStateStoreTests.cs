using PRism.Core.State;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

public class InMemoryAppStateStoreTests
{
    [Fact]
    public async Task UpdateAsync_AppliesTransform_AndLoadAsyncSeesIt()
    {
        var store = new InMemoryAppStateStore();
        await store.UpdateAsync(s => s.WithDefaultLastConfiguredGithubHost("https://github.com"), CancellationToken.None);
        var loaded = await store.LoadAsync(CancellationToken.None);
        Assert.Equal("https://github.com", loaded.LastConfiguredGithubHost);
    }

    [Fact]
    public async Task SeedSession_MakesSessionRetrievable()
    {
        var store = new InMemoryAppStateStore();
        var session = new ReviewSessionState(
            LastViewedHeadSha: "h", LastSeenCommentId: null,
            PendingReviewId: null, PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: new List<DraftComment>(),
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null, DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);

        store.SeedSession("owner/repo/1", session);

        Assert.Same(session, store.Session("owner/repo/1"));
        Assert.Null(store.Session("owner/repo/999"));
    }
}
