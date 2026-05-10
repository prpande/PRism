using PRism.Core.Reconciliation;
using PRism.Core.Reconciliation.Pipeline;
using PRism.Core.State;
using PRism.Core.Tests.Reconciliation.Fakes;

namespace PRism.Core.Tests.Reconciliation;

public class OverrideStaleTests
{
    private const string OldSha = "0000000000000000000000000000000000000001";
    private const string NewSha = "0000000000000000000000000000000000000002";

    [Fact]
    public async Task IsOverriddenStaleTrueAndAnchoredShaReachable_ClassifierShortCircuitsToDraft()
    {
        // Plan deviation (documented in deferrals): the original test wrote
        // session.LastViewedHeadSha = OldSha while reloading to NewSha, which counts as a
        // head shift and clears the override BEFORE the matrix runs (per Test 4's contract).
        // For the override to actually short-circuit, head must NOT have shifted — so the
        // session's last-known head matches the reload target.
        var content = "line X\nline Y\nline Z\n";   // no exact / whitespace-equiv match at line 2
        var draft = MakeDraft(isOverridden: true);
        var session = SessionWith(NewSha, draft);   // no head shift
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });

        var result = await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);   // override short-circuit
        Assert.True(d.IsOverriddenStale);
    }

    [Fact]
    public async Task IsOverriddenStaleTrueButForcePushFallback_OverrideIgnored_StillStale()
    {
        var content = "  line B  \n  line B  \n";
        var draft = MakeDraft(isOverridden: true);
        var result = await RunUnreachable(content, draft);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.True(d.ForcePushFallbackTriggered);
        Assert.False(d.IsOverriddenStale);   // cleared (anchor reasoning is broken)
    }

    [Fact]
    public async Task IsOverriddenStaleTrueButContentNowMatches_OverrideCleared()
    {
        var content = "line A\nline B\nline C\n";   // exact match at line 2
        var draft = MakeDraft(isOverridden: true);
        var result = await RunReachable(content, draft);

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Draft, d.Status);
        Assert.False(d.IsOverriddenStale);   // override no longer needed; cleared
    }

    [Fact]
    public async Task HeadShiftBetweenReloads_ClearsOverride()
    {
        // Per spec § 3.2: "On head shift (any headSha change since the override was set),
        // IsOverriddenStale is cleared." This test exercises that contract: the draft was
        // overridden at OldSha; reloading against a DIFFERENT NewSha (head shifted) must
        // strip the override BEFORE the classifier runs, so a stale-classifying content
        // state once again produces Status=Stale.
        var content = "line X\nline Y\nline Z\n";   // no match at line 2
        var draft = MakeDraft(isOverridden: true);
        var result = await RunReachable(content, draft);   // session.LastViewedHeadSha = OldSha → shift

        var d = Assert.Single(result.Drafts);
        Assert.Equal(DraftStatus.Stale, d.Status);
        Assert.False(d.IsOverriddenStale);
    }

    private static async Task<ReconciliationResult> RunReachable(string content, DraftComment draft)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { OldSha, NewSha });
        var session = SessionWith(OldSha, draft);
        return await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static async Task<ReconciliationResult> RunUnreachable(string content, DraftComment draft)
    {
        var fake = new FakeFileContentSource(
            files: new() { [("src/Foo.cs", NewSha)] = content },
            reachableShas: new() { NewSha });
        var session = SessionWith(OldSha, draft);
        return await new DraftReconciliationPipeline().ReconcileAsync(session, NewSha, fake, CancellationToken.None);
    }

    private static DraftComment MakeDraft(bool isOverridden)
        => new(
            Id: "d1",
            FilePath: "src/Foo.cs",
            LineNumber: 2,
            Side: "right",
            AnchoredSha: OldSha,
            AnchoredLineContent: "line B",
            BodyMarkdown: "body",
            Status: DraftStatus.Draft,
            IsOverriddenStale: isOverridden);

    private static ReviewSessionState SessionWith(string lastViewedHeadSha, params DraftComment[] drafts)
        => new(
            LastViewedHeadSha: lastViewedHeadSha,
            LastSeenCommentId: null,
            PendingReviewId: null,
            PendingReviewCommitOid: null,
            ViewedFiles: new Dictionary<string, string>(),
            DraftComments: drafts,
            DraftReplies: new List<DraftReply>(),
            DraftSummaryMarkdown: null,
            DraftVerdict: null,
            DraftVerdictStatus: DraftVerdictStatus.Draft);
}
