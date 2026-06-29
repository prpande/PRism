using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Core.Tests.Submit.Pipeline.Fakes;

namespace PRism.Core.Tests.Submit.Pipeline;

// #659 (remainder of #605 B) — the pipeline must re-read each draft / reply / PR-root-summary body
// from the store immediately before its GitHub call, so a concurrent PUT /draft that landed after
// the endpoint captured its pre-lock snapshot is reflected in what GitHub receives, not lost.
//
// The race is modeled as snapshot-vs-store divergence (the real-world condition): the `session`
// argument is the stale pre-lock snapshot carrying body "v1"; the store holds "v2" from a
// concurrent PUT /draft. Pre-fix the submitter receives "v1"; post-fix, "v2". Finalize is injected
// to fail so the pending review (and its attached bodies) survive in the fake for inspection.
public class BodyReReadUnderLockTests
{
    private static PrReference Ref => new("owner", "repo", 1);
    private const string SessionKey = "owner/repo/1";

    private static InMemoryReviewSubmitter FakeFailingFinalize()
    {
        var fake = new InMemoryReviewSubmitter();
        fake.InjectFailure(nameof(IReviewSubmitter.FinalizePendingReviewAsync), new HttpRequestException("simulated"));
        return fake;
    }

    // Site 1 — thread fresh-create: an unstamped draft posts the latest persisted body.
    [Fact]
    public async Task AttachThread_reReads_draft_body_so_concurrent_edit_is_not_lost()
    {
        var fake = FakeFailingFinalize();

        var snapshot = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", body: "v1") });
        var stored = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", body: "v2") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var thread = Assert.Single(fake.GetPending(Ref)!.Threads);
        Assert.Equal(PipelineMarker.Inject("v2", "d1"), thread.Body);
    }

    // Site 1 (recreate fall-through) — a stamped draft whose thread is gone from the server snapshot
    // recreates through the SAME body-sending block, so it must also re-read. Guards the shared
    // chokepoint if create / recreate ever diverge.
    [Fact]
    public async Task AttachThread_recreatePath_reReads_draft_body()
    {
        var fake = FakeFailingFinalize();
        // A pending review exists (resume-by-id) but carries NO threads → the draft's stamped
        // ThreadId is absent on the server → falls through to recreate.
        fake.SeedPendingReview(Ref, new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, ""));

        var snapshot = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1", threadId: "PRRT_gone", body: "v1") });
        var stored = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            drafts: new[] { SessionFactory.Draft("d1", threadId: "PRRT_gone", body: "v2") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.Equal(1, fake.AttachThreadCallCount);  // recreated, not skipped
        var thread = Assert.Single(fake.GetPending(Ref)!.Threads);
        Assert.Equal(PipelineMarker.Inject("v2", "d1"), thread.Body);
    }

    // Site 2 — reply create: an unstamped reply on a present parent posts the latest persisted body.
    [Fact]
    public async Task AttachReply_reReads_reply_body_so_concurrent_edit_is_not_lost()
    {
        var fake = FakeFailingFinalize();
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_parent", "src/Foo.cs", 1, "RIGHT", "head1",
            Body: "parent body", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>()));
        fake.SeedPendingReview(Ref, pending);

        var snapshot = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent", body: "v1") });
        var stored = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent", body: "v2") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var parent = fake.GetPending(Ref)!.Threads.Single(t => t.Id == "PRRT_parent");
        var reply = Assert.Single(parent.Replies);
        Assert.Equal(PipelineMarker.Inject("v2", "r1"), reply.Body);
    }

    // Site 2 (recreate fall-through) — a reply whose stamped ReplyCommentId is gone from the parent's
    // server reply chain recreates through the SAME re-read block. Mirrors the thread recreate test —
    // guards the shared chokepoint if create / recreate ever diverge for replies (they're separate
    // branches today). Bot F1.
    [Fact]
    public async Task AttachReply_recreatePath_reReads_reply_body()
    {
        var fake = FakeFailingFinalize();
        // Parent thread present but with NO replies → the reply's stamped ReplyCommentId is absent on
        // the server → falls through to recreate.
        var pending = new InMemoryReviewSubmitter.InMemoryPendingReview("PRR_x", "head1", DateTimeOffset.UtcNow, "");
        pending.Threads.Add(new InMemoryReviewSubmitter.InMemoryThread(
            "PRRT_parent", "src/Foo.cs", 1, "RIGHT", "head1",
            Body: "parent body", IsResolved: false,
            Replies: new List<InMemoryReviewSubmitter.InMemoryComment>()));
        fake.SeedPendingReview(Ref, pending);

        var snapshot = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent", replyCommentId: "PRRC_gone", body: "v1") });
        var stored = SessionFactory.With(headSha: "head1", pendingReviewId: "PRR_x",
            replies: new[] { SessionFactory.Reply("r1", "PRRT_parent", replyCommentId: "PRRC_gone", body: "v2") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.Equal(1, fake.AttachReplyCallCount);  // recreated, not skipped
        var parent = fake.GetPending(Ref)!.Threads.Single(t => t.Id == "PRRT_parent");
        var reply = Assert.Single(parent.Replies);
        Assert.Equal(PipelineMarker.Inject("v2", "r1"), reply.Body);
    }

    // Site 3 — PR-root summary at Begin (fresh start): the review body sent to BeginPendingReview
    // reflects the latest persisted summary. (Summary is NOT marker-injected.)
    [Fact]
    public async Task Begin_reReads_pr_root_summary_so_concurrent_edit_is_not_lost()
    {
        var fake = FakeFailingFinalize();

        var snapshot = SessionFactory.With(headSha: "head1", summary: "v1");
        var stored = SessionFactory.With(headSha: "head1", summary: "v2");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        Assert.Equal("v2", fake.GetPending(Ref)!.SummaryBody);
    }

    // Failure-path lockstep — after a thread posts the re-read body (v2), a later Finalize failure
    // must return an at-failure session whose draft body is v2 (what GitHub got), not the stale
    // snapshot v1. Otherwise the endpoint's wholesale WithSession persist of the at-failure session
    // would revert the store to v1 while GitHub keeps v2 — a new GitHub-vs-local divergence.
    [Fact]
    public async Task ThreadPosted_thenFinalizeFails_atFailureSession_carries_reReadBody()
    {
        var fake = FakeFailingFinalize();

        var snapshot = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", body: "v1") });
        var stored = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", body: "v2") });
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        var outcome = await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var failed = Assert.IsType<SubmitOutcome.Failed>(outcome);
        Assert.Equal(SubmitStep.Finalize, failed.FailedStep);
        Assert.Equal("v2", failed.NewSession.DraftComments.Single(d => d.Id == "d1").BodyMarkdown);
    }

    // Null-fallback — when the draft is absent from the store (re-read returns null), the pipeline
    // falls back to the snapshot body, so the `?? draft.BodyMarkdown` branch is live, not dead. The
    // store session is present but carries no drafts (the draft was removed mid-submit); the snapshot
    // still drives the attach loop. Correctness can only improve, never regress. Bot F4.
    [Fact]
    public async Task AttachThread_draftAbsentFromStore_fallsBackToSnapshotBody()
    {
        var fake = FakeFailingFinalize();

        var snapshot = SessionFactory.With(headSha: "head1", drafts: new[] { SessionFactory.Draft("d1", body: "v1") });
        // Store session exists but has NO drafts → ReloadDraftBodyAsync returns null → fallback.
        var stored = SessionFactory.With(headSha: "head1");
        var store = new InMemoryAppStateStore();
        store.SeedSession(SessionKey, stored);
        var pipeline = new SubmitPipeline(fake, store);

        await pipeline.SubmitAsync(Ref, snapshot, SubmitEvent.Comment, "head1", NoopProgress.Instance, CancellationToken.None);

        var thread = Assert.Single(fake.GetPending(Ref)!.Threads);
        Assert.Equal(PipelineMarker.Inject("v1", "d1"), thread.Body);
    }
}
