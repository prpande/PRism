using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// Spec § 5.2 step 3 — Attach threads: stamped-and-present → skip; unstamped + no marker → create
// and stamp; plus the per-stamp persistence promise (spec § 5.3 — a process kill mid-step preserves
// what's already attached, observed here via a Finalize failure that leaves the persisted session
// uncleared).
public class AttachThreadsTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    [Fact]
    public async Task UnstampedDraft_NoMarkerMatch_CallsAttachThreadOnce_ReachesSuccess()
    {
        var fake = new InMemoryReviewSubmitter();
        var session = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(1, fake.AttachThreadCallCount);
        Assert.Null(fake.GetPending(Ref));  // Finalized.
        Assert.Empty(store.Session(SessionKey)!.DraftComments);  // Success clears the drafts.
    }

    [Fact]
    public async Task StampedDraft_PresentInSnapshot_NotReattached()
    {
        var fake = new InMemoryReviewSubmitter();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_existing", "src/Foo.cs", 42, "RIGHT", "head1",
            Body: "body\n\n<!-- prism:client-id:d1 -->", IsResolved: false, Replies: new List<InMemoryReviewSubmitter.InMemoryComment>()));
        fake.SeedPendingReview(Ref, pending);

        var session = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1", threadId: "PRRT_existing") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);
        Assert.Equal(0, fake.AttachThreadCallCount);  // already attached on a prior attempt — not re-created.
    }

    [Theory]
    [InlineData("right", "RIGHT")]
    [InlineData("left", "LEFT")]
    [InlineData("RIGHT", "RIGHT")]
    [InlineData("LEFT", "LEFT")]
    public async Task UnstampedDraft_DraftSideIsNormalisedToUppercase_OnAttach(string draftSide, string expectedAttachedSide)
    {
        // The DraftComment.Side field is lowercase on the wire (DraftSide = 'left' | 'right' in
        // frontend/src/api/types.ts), but GraphQL's DiffSide! enum strict-rejects lowercase. The
        // pipeline normalises at the AttachThreads boundary so the GitHub call always sees uppercase
        // — caught originally by the real-flow happy-path Playwright spec; the fake submitter
        // accepted both casings so the bug never surfaced under fake-mode coverage.
        //
        // Finalize is injected to fail so the pending review (and its threads) survive in the fake
        // for inspection — a successful Finalize would Remove the pending review.
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));
        var session = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", side: draftSide) });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var attachedThread = Assert.Single(fake.GetPending(Ref)!.Threads);
        Assert.Equal(expectedAttachedSide, attachedThread.Side);
    }

    [Fact]
    public async Task UnstampedDraft_AttachThenFinalizeFails_StampPersistedBeforeFinalize()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));

        var session = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        // Per-stamp persistence: the thread id was written to the session before Finalize ran (and
        // the success-clear never reached it because Finalize failed).
        var persistedDraft = Assert.Single(store.Session(SessionKey)!.DraftComments);
        Assert.NotNull(persistedDraft.ThreadId);
        Assert.NotNull(store.Session(SessionKey)!.PendingReviewId);
        // The Failed outcome carries the same at-failure session shape.
        Assert.NotNull(failed.NewSession.DraftComments.Single(d => d.Id == "d1").ThreadId);

        // Retry from the at-failure session: Step 3 sees the stamped draft already present, skips
        // re-attach, and Finalize (no longer failing) converges on Success — no duplicate thread.
        var retry = await pipeline.SubmitAsync(Ref, failed.NewSession, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);
        Assert.IsType<SubmitOutcome.Success>(retry);
        Assert.Equal(1, fake.AttachThreadCallCount);  // exactly one AttachThreadAsync across both attempts.
    }

    // Task 7 — PR-root drafts (FilePath/LineNumber both null) must be silently filtered out of the
    // inline-thread attach loop. The PR-root body already ships as review.body via ExtractPrRootBody
    // (called in BeginPendingReviewAsync). The attach loop must not throw on the PR-root draft.
    // Finalize is injected to fail so the pending review (and its SummaryBody) survive for inspection.
    [Fact]
    public async Task AttachThreads_filters_pr_root_drafts_silently()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));
        var inlineDraft = SessionFactory.Draft("d-inline");
        var prRootDraft = new DraftComment(
            Id: "d-root",
            FilePath: null, LineNumber: null, Side: "pr",
            AnchoredSha: null, AnchoredLineContent: null,
            BodyMarkdown: "This is the PR-level comment.",
            Status: DraftStatus.Draft, IsOverriddenStale: false);

        var session = SessionFactory.With(headSha: "head1", drafts: new[] { inlineDraft, prRootDraft });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        // Finalize failed — outcome is Failed at Finalize, NOT at AttachThreads. The PR-root draft
        // was silently skipped (not thrown on), so the pipeline reached Finalize.
        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        // Only the inline draft was attached as a thread — the PR-root draft was filtered out.
        Assert.Equal(1, fake.AttachThreadCallCount);
        // The PR-root body was forwarded as review.body via BeginPendingReviewAsync / ExtractPrRootBody.
        // The pending review is still present because Finalize failed before removing it.
        Assert.Equal("This is the PR-level comment.", fake.GetPending(Ref)!.SummaryBody);
    }

    // Task 7 — ClearSubmittedSession clause 1: a Stale-and-not-overridden inline draft must survive
    // the submit. The normal (Draft-status) inline draft is consumed and removed; only the stale one
    // remains. Deleting clause 1 from the Where predicate would drop the stale draft → assertion fails.
    [Fact]
    public async Task SuccessfulSubmit_keeps_stale_not_overridden_inline_draft()
    {
        var fake = new InMemoryReviewSubmitter();
        // A normal inline draft: gets attached + consumed by submit (AttachThreads does not filter it).
        var normalDraft = SessionFactory.Draft("d-normal");
        // A stale-not-overridden inline draft: AttachThreads filters it (Status != Draft), so it is
        // never attached. ClearSubmittedSession clause 1 must keep it post-success.
        var staleDraft = new DraftComment(
            Id: "d-stale",
            FilePath: "src/Foo.cs", LineNumber: 10, Side: "RIGHT",
            AnchoredSha: "anchorsha", AnchoredLineContent: "line",
            BodyMarkdown: "stale comment",
            Status: DraftStatus.Stale, IsOverriddenStale: false,
            PostedCommentId: null);

        var session = SessionFactory.With(headSha: "head1", drafts: new[] { normalDraft, staleDraft });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);

        var persisted = store.Session(SessionKey)!;
        // Clause 1 keeps the stale-not-overridden draft; the normal draft is consumed → removed.
        var surviving = Assert.Single(persisted.DraftComments);
        Assert.Equal("d-stale", surviving.Id);
        Assert.DoesNotContain(persisted.DraftComments, d => d.Id == "d-normal");
    }

    // Task 7 — on success, ClearSubmittedSession must keep Posted PR-root drafts (their lifecycle
    // belongs to the issue-comment path, not the review path) and drop unposted PR-root drafts
    // (their body was consumed as review.body by the submit).
    [Fact]
    public async Task SuccessfulSubmit_removes_unposted_pr_root_draft_keeps_posted_one()
    {
        var fake = new InMemoryReviewSubmitter();
        var inlineDraft = SessionFactory.Draft("d-inline");
        var unpostedRoot = new DraftComment(
            Id: "d-root-unposted",
            FilePath: null, LineNumber: null, Side: "pr",
            AnchoredSha: null, AnchoredLineContent: null,
            BodyMarkdown: "Unposted PR comment.",
            Status: DraftStatus.Draft, IsOverriddenStale: false,
            PostedCommentId: null);
        var postedRoot = new DraftComment(
            Id: "d-root-posted",
            FilePath: null, LineNumber: null, Side: "pr",
            AnchoredSha: null, AnchoredLineContent: null,
            BodyMarkdown: "Already posted PR comment.",
            Status: DraftStatus.Draft, IsOverriddenStale: false,
            PostedCommentId: 99L);

        var session = SessionFactory.With(headSha: "head1", drafts: new[] { inlineDraft, unpostedRoot, postedRoot });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, session);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, session, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.IsType<SubmitOutcome.Success>(outcome);

        var persisted = store.Session(SessionKey)!;
        // The inline draft and the unposted PR-root draft were consumed by submit → both removed.
        // The posted PR-root draft survives because its lifecycle is independent of the review.
        var surviving = Assert.Single(persisted.DraftComments);
        Assert.Equal("d-root-posted", surviving.Id);
        Assert.Equal(99L, surviving.PostedCommentId);
    }
}
