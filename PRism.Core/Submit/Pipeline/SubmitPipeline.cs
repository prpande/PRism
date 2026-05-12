using PRism.Core.Contracts;
using PRism.Core.State;
using PRism.Core.Submit;

namespace PRism.Core.Submit.Pipeline;

// The resumable, step-granular submit state machine (spec § 5). Mirrors PRism.Core/Reconciliation/
// Pipeline/: one public entry-point class, internal step logic, fully unit-testable against an
// IReviewSubmitter fake — no WebApplicationFactory, no HTTP. The endpoint layer (PR3) wires the
// IProgress -> SSE bridge and the per-PR submit lock; the pipeline core never touches either.
//
// Persistence: the pipeline takes IAppStateStore by constructor (revision R1) and persists each
// step's effect — the BeginPendingReview stamp, every per-draft ThreadId / per-reply ReplyCommentId
// stamp, the stale-commitOID clear, and the success clear — as an *overlay* UpdateAsync that
// re-reads the current session and edits only the field in question. That overlay shape is what
// makes a process kill mid-pipeline recoverable (spec § 5.3) and what defends against a foreign-tab
// PUT /draft committing between the pipeline's snapshot-load and a stamp (adversarial #4).
public sealed class SubmitPipeline
{
    private readonly IReviewSubmitter _submitter;
    private readonly IAppStateStore _stateStore;
    private readonly Action<string>? _onDuplicateMarker;
    private readonly Func<CancellationToken, Task<string>>? _getCurrentHeadShaAsync;

    public SubmitPipeline(
        IReviewSubmitter submitter,
        IAppStateStore stateStore,
        Action<string>? onDuplicateMarker = null,
        Func<CancellationToken, Task<string>>? getCurrentHeadShaAsync = null)
    {
        _submitter = submitter ?? throw new ArgumentNullException(nameof(submitter));
        _stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        _onDuplicateMarker = onDuplicateMarker;
        _getCurrentHeadShaAsync = getCurrentHeadShaAsync;
    }

    // Endpoint contract: the caller MUST have persisted `session` under `reference.ToString()` in the
    // state store before invoking this. Every per-stamp overlay transform re-reads the session under
    // that key and no-ops if it's absent — so a session that was never persisted there would silently
    // lose all the pipeline's progress on a mid-run kill, defeating resumability (spec § 5.3).
    public async Task<SubmitOutcome> SubmitAsync(
        PrReference reference,
        ReviewSessionState session,
        SubmitEvent verdict,
        string currentHeadSha,
        IProgress<SubmitProgressEvent> progress,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(reference);
        ArgumentNullException.ThrowIfNull(session);
        ArgumentException.ThrowIfNullOrEmpty(currentHeadSha);
        ArgumentNullException.ThrowIfNull(progress);

        var sessionKey = reference.ToString();  // "<owner>/<repo>/<number>" — the ReviewSessionState key

        try
        {
            // ---- Step 1 — Detect existing pending review (spec § 5.2 step 1) ----
            progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Started, 0, 0));
            var existing = await InvokeAsync(SubmitStep.DetectExistingPendingReview, 0, 0, session, progress,
                () => _submitter.FindOwnPendingReviewAsync(reference, ct)).ConfigureAwait(false);

            string pendingReviewId;
            var workingSession = session;

            if (existing is null)
            {
                // No pending review → Step 2 (Begin).
                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                pendingReviewId = await StepBeginAsync(reference, sessionKey, session, currentHeadSha, progress, ct).ConfigureAwait(false);
                workingSession = workingSession with { PendingReviewId = pendingReviewId, PendingReviewCommitOid = currentHeadSha };
            }
            else if (string.Equals(session.PendingReviewId, existing.PullRequestReviewId, StringComparison.Ordinal))
            {
                // Match by id → resume.
                if (!string.Equals(existing.CommitOid, currentHeadSha, StringComparison.Ordinal))
                {
                    // ---- Stale-commitOID branch (spec § 5.2) ----
                    // Surface "Recreating against new head sha…" before the destructive call (spec
                    // § 5.2 step 1 mandates this second Started so the dialog banner can update — a
                    // progress consumer sees Started→…→Started→Succeeded for DetectExistingPendingReview;
                    // the duplicate Started is intentional and the endpoint's SSE bridge dedups/re-renders).
                    // Then delete the orphan, clear the session's pending state + every stamp, emit the
                    // terminal Succeeded, and hand the StaleCommitOidRecreating outcome back; the endpoint
                    // persists nothing more (the clear already happened here) and the user re-confirms / re-runs.
                    progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Started, 0, 0));
                    await InvokeAsync(SubmitStep.DetectExistingPendingReview, 0, 0, session, progress,
                        () => _submitter.DeletePendingReviewAsync(reference, existing.PullRequestReviewId, ct)).ConfigureAwait(false);
                    await PersistOrFailAsync(SubmitStep.DetectExistingPendingReview, session, progress,
                        state => ClearPendingReviewStamps(state, sessionKey), ct).ConfigureAwait(false);
                    progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                    return new SubmitOutcome.StaleCommitOidRecreating(existing.PullRequestReviewId, existing.CommitOid);
                }

                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                pendingReviewId = existing.PullRequestReviewId;
            }
            else
            {
                // A pending review exists that isn't ours → prompt (endpoint surfaces the modal;
                // TOCTOU defense is endpoint-side, not here).
                progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Succeeded, 1, 1));
                return new SubmitOutcome.ForeignPendingReviewPromptRequired(existing);
            }

            // ---- Step 3 — attach threads (spec § 5.2 step 3) ----
            // Skipped (no progress events) when DraftComments is empty. `existing` doubles as the
            // detection snapshot for the stamped-thread verify branch and the lost-response marker
            // adoption scan.
            workingSession = await StepAttachThreadsAsync(reference, sessionKey, pendingReviewId, workingSession, existing, progress, ct).ConfigureAwait(false);

            // ---- Step 4 — attach replies (spec § 5.2 step 4) ----
            // Skipped (no progress events) when DraftReplies is empty. Re-fetches the snapshot —
            // Step 3 just created new threads, so the Step 1 snapshot is stale.
            workingSession = await StepAttachRepliesAsync(reference, sessionKey, pendingReviewId, workingSession, progress, ct).ConfigureAwait(false);

            // ---- Pre-Finalize head_sha re-poll (revision R11) ----
            // Catch a push that landed mid-pipeline. The endpoint passes a callback that re-runs a
            // fresh PollActivePrAsync (not the ~30s poller cache). If head drifted, bail with Failed
            // so the user Reloads + reconciles before re-submitting.
            if (_getCurrentHeadShaAsync is not null)
            {
                var fresh = await InvokeAsync(SubmitStep.Finalize, 0, 1, workingSession, progress,
                    () => _getCurrentHeadShaAsync(ct)).ConfigureAwait(false);
                if (!string.Equals(fresh, currentHeadSha, StringComparison.Ordinal))
                {
                    progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Failed, 0, 1, "head_sha drift"));
                    return new SubmitOutcome.Failed(SubmitStep.Finalize, "head_sha drifted before Finalize; Reload and re-submit", workingSession);
                }
            }

            // ---- Step 5 — Finalize (spec § 5.2 step 5) ----
            await StepFinalizeAsync(reference, pendingReviewId, verdict, workingSession, progress, ct).ConfigureAwait(false);

            // On success — clear PendingReviewId / PendingReviewCommitOid / every draft / every reply
            // / DraftSummaryMarkdown / DraftVerdict / DraftVerdictStatus. The endpoint publishes
            // DraftSubmitted + StateChanged OUTSIDE _gate after this returns (spec § 5.2 step 5).
            // The review is already submitted server-side at this point, so a store/disk failure on
            // the cleanup write is swallowed rather than turned into Failed — returning Failed would
            // be worse: a retry would find no pending review, Begin a fresh one, and re-attach every
            // draft → a DUPLICATE review on github.com. Stale local drafts that reference now-submitted
            // threads are harmless; the endpoint may re-attempt the clear on its side.
            try
            {
                await _stateStore.UpdateAsync(state => ClearSubmittedSession(state, sessionKey), ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
#pragma warning disable CA1031 // submit already succeeded server-side; failing the submit on a cleanup-write error would risk a duplicate review on retry
            catch (Exception)
            {
                // best-effort; the review is submitted regardless.
            }
#pragma warning restore CA1031

            return new SubmitOutcome.Success(pendingReviewId);
        }
        catch (SubmitFailedException sfe)
        {
            return new SubmitOutcome.Failed(sfe.Step, sfe.Message, sfe.SessionAtFailure ?? session);
        }
    }

    // ---- Step 2 — Begin pending review ----
    private async Task<string> StepBeginAsync(
        PrReference reference, string sessionKey, ReviewSessionState session,
        string currentHeadSha, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        progress.Report(new SubmitProgressEvent(SubmitStep.BeginPendingReview, SubmitStepStatus.Started, 0, 1));
        var result = await InvokeAsync(SubmitStep.BeginPendingReview, 0, 1, session, progress,
            () => _submitter.BeginPendingReviewAsync(reference, currentHeadSha, session.DraftSummaryMarkdown ?? "", ct)).ConfigureAwait(false);

        // Stamp the new pending-review id immediately (caller persisted the session under sessionKey);
        // if this fails, the at-failure session carries the stamp so the endpoint persists it on retry
        // — otherwise the next submit would see the server's review with no local record and treat it
        // as a *foreign* pending review.
        var stamped = session with { PendingReviewId = result.PullRequestReviewId, PendingReviewCommitOid = currentHeadSha };
        await PersistOrFailAsync(SubmitStep.BeginPendingReview, stamped, progress,
            state => StampPendingReview(state, sessionKey, result.PullRequestReviewId, currentHeadSha), ct).ConfigureAwait(false);
        progress.Report(new SubmitProgressEvent(SubmitStep.BeginPendingReview, SubmitStepStatus.Succeeded, 1, 1));
        return result.PullRequestReviewId;
    }

    // ---- Step 5 — Finalize ----
    private async Task StepFinalizeAsync(
        PrReference reference, string pendingReviewId, SubmitEvent verdict,
        ReviewSessionState workingSession, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Started, 0, 1));
        await InvokeAsync(SubmitStep.Finalize, 0, 1, workingSession, progress,
            () => _submitter.FinalizePendingReviewAsync(reference, pendingReviewId, verdict, ct)).ConfigureAwait(false);
        progress.Report(new SubmitProgressEvent(SubmitStep.Finalize, SubmitStepStatus.Succeeded, 1, 1));
    }

    // ---- Step 3 — Attach threads (spec § 5.2 step 3) ----
    // Per draft (excluding Stale — rule (b) blocks submit on those, so they shouldn't be here):
    //  - ThreadId set + present in the snapshot → skip (already attached on a prior attempt)
    //  - ThreadId set + absent → recreate (resolved/deleted on github.com between attempts)
    //  - ThreadId null + exactly one server thread carries the draft's marker → adopt it (the
    //    lost-response window: a prior AttachThread succeeded server-side but the response never
    //    reached us, so the draft is unstamped locally)
    //  - ThreadId null + N>1 markered threads → multi-marker-match defense (Task 29)
    //  - ThreadId null + no marker match → AttachThreadAsync (marker injected) + stamp
    // Every stamp is persisted as an overlay (StampDraftThreadIdAsync) so a process kill mid-step
    // preserves what's already attached (spec § 5.3). Returns the updated working snapshot.
    private async Task<ReviewSessionState> StepAttachThreadsAsync(
        PrReference reference, string sessionKey, string pendingReviewId, ReviewSessionState session,
        OwnPendingReviewSnapshot? detectionSnapshot, IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        var drafts = session.DraftComments.Where(d => d.Status != DraftStatus.Stale).ToList();
        if (drafts.Count == 0) return session;

        var total = drafts.Count;
        progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Started, 0, total));

        // Step 1's detection snapshot is the source of truth; re-fetch only if Step 1 took the
        // no-pending branch (then Begin created an empty review whose threads we still need to scan
        // — a lost-response on the very first AttachThread would surface only here).
        var snapshot = detectionSnapshot ?? await InvokeAsync(SubmitStep.AttachThreads, 0, total, session, progress,
            () => _submitter.FindOwnPendingReviewAsync(reference, ct)).ConfigureAwait(false);
        if (snapshot is null)
        {
            // We have a pending review (Step 1 found it, or Begin just created it) but the re-fetch
            // returned null — GitHub's reviews(...) list query lagging. Treat as a retryable step
            // failure rather than re-creating every thread (which would double-post on a lost-response
            // retry); the next attempt's snapshot will reflect reality. Emit the terminal Failed so a
            // progress consumer sees a matching event for the Started above.
            const string msg = "could not fetch the pending-review snapshot to reconcile threads; retry";
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Failed, 0, total, msg));
            throw new SubmitFailedException(SubmitStep.AttachThreads, msg, session);
        }

        var current = session;
        var done = 0;
        foreach (var draft in drafts)
        {
            if (draft.ThreadId is not null)
            {
                // snapshot is non-null here — the null-snapshot guard above threw a retryable failure.
                var stillThere = snapshot.Threads.Any(t => string.Equals(t.PullRequestReviewThreadId, draft.ThreadId, StringComparison.Ordinal));
                if (stillThere)
                {
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                // Falls through to recreate.
            }
            else
            {
                var markered = MarkeredThreads(snapshot, draft.Id);
                if (markered.Count == 1)
                {
                    var adoptedId = markered[0].PullRequestReviewThreadId;
                    current = StampDraftThreadId(current, draft.Id, adoptedId);
                    await PersistOrFailAsync(SubmitStep.AttachThreads, current, progress,
                        st => StampDraftThreadIdOverlay(st, sessionKey, draft.Id, adoptedId), ct).ConfigureAwait(false);
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                if (markered.Count > 1)
                {
                    // Multi-marker-match defense (spec § 5.2 step 3 / § 5.3 invariant 3): GitHub's
                    // pending-review listing isn't strictly read-your-writes consistent, so a lost
                    // response + retry can leave N>1 server threads carrying the same draft's marker.
                    // Adopt the earliest (lowest CreatedAt; markered is already ordered earliest-first)
                    // and best-effort-delete the rest — don't abort the pipeline on a cleanup failure;
                    // surface it through the onDuplicateMarker notice instead.
                    var earliest = markered[0];
                    current = StampDraftThreadId(current, draft.Id, earliest.PullRequestReviewThreadId);
                    await PersistOrFailAsync(SubmitStep.AttachThreads, current, progress,
                        st => StampDraftThreadIdOverlay(st, sessionKey, draft.Id, earliest.PullRequestReviewThreadId), ct).ConfigureAwait(false);
                    foreach (var dup in markered.Skip(1))
                        await TryDeleteDuplicateThreadAsync(reference, draft.Id, dup.PullRequestReviewThreadId, ct).ConfigureAwait(false);
                    _onDuplicateMarker?.Invoke(
                        $"draft {draft.Id}: {markered.Count} server threads carried its marker; adopted {earliest.PullRequestReviewThreadId}, deleted the rest (best-effort)");
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                // Falls through to create.
            }

            if (draft.FilePath is null || draft.LineNumber is null)
            {
                // PR-root drafts (no diff anchor) can't be attached as inline threads on a pending
                // review — GitHub's addPullRequestReviewThread requires a path + line. Fail loud so
                // the user discards/rewrites rather than silently dropping their comment. (Folding
                // PR-root drafts into the review summary is deferred — see the deferrals sidecar.)
                var msg = $"draft {draft.Id} has no diff anchor; PR-root comments aren't submittable as part of a pending review";
                progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Failed, done, total, msg));
                throw new SubmitFailedException(SubmitStep.AttachThreads, msg, current);
            }

            var request = new DraftThreadRequest(
                DraftId: draft.Id,
                BodyMarkdown: PipelineMarker.Inject(draft.BodyMarkdown, draft.Id),
                FilePath: draft.FilePath,
                LineNumber: draft.LineNumber.Value,
                Side: draft.Side ?? "RIGHT");

            var result = await InvokeAsync(SubmitStep.AttachThreads, done, total, current, progress,
                () => _submitter.AttachThreadAsync(reference, pendingReviewId, request, ct)).ConfigureAwait(false);

            current = StampDraftThreadId(current, draft.Id, result.PullRequestReviewThreadId);
            await PersistOrFailAsync(SubmitStep.AttachThreads, current, progress,
                st => StampDraftThreadIdOverlay(st, sessionKey, draft.Id, result.PullRequestReviewThreadId), ct).ConfigureAwait(false);
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachThreads, SubmitStepStatus.Succeeded, ++done, total));
        }

        return current;
    }

    // Server threads whose body's <!-- prism:client-id:<id> --> marker matches draftId, ordered
    // earliest-first (CreatedAt, thread id as a stable tiebreak) so the multi-match defense can
    // adopt the earliest deterministically.
    private static List<PendingReviewThreadSnapshot> MarkeredThreads(OwnPendingReviewSnapshot? snapshot, string draftId)
        => snapshot is null
            ? new List<PendingReviewThreadSnapshot>()
            : snapshot.Threads
                .Where(t => string.Equals(PipelineMarker.Extract(t.BodyMarkdown), draftId, StringComparison.Ordinal))
                .OrderBy(t => t.CreatedAt)
                .ThenBy(t => t.PullRequestReviewThreadId, StringComparer.Ordinal)
                .ToList();

    private async Task TryDeleteDuplicateThreadAsync(PrReference reference, string draftId, string threadId, CancellationToken ct)
    {
        try
        {
            await _submitter.DeletePendingReviewThreadAsync(reference, threadId, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // cleanup is best-effort by design — a failure is reported, not fatal
        catch (Exception ex)
        {
            _onDuplicateMarker?.Invoke($"draft {draftId}: failed to delete duplicate thread {threadId}: {ex.Message}");
        }
#pragma warning restore CA1031
    }

    // ---- Step 4 — Attach replies (spec § 5.2 step 4) ----
    // Mirrors Step 3 per reply (excluding Stale): stamped-and-present → skip; unstamped + marker in
    // the parent thread's reply chain → adopt; unstamped + no match → AttachReplyAsync (marker
    // injected) + stamp. Extra: if the parent thread no longer exists on the pending review (its
    // author deleted it between submit attempts on github.com), demote the reply to Stale and return
    // Failed(AttachReplies, …) — submit blocks via rule (b) on the next attempt; the user discards
    // or rewrites as a new top-level thread. Re-fetches the snapshot first (Step 3 created threads).
    private async Task<ReviewSessionState> StepAttachRepliesAsync(
        PrReference reference, string sessionKey, string pendingReviewId, ReviewSessionState session,
        IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        var replies = session.DraftReplies.Where(r => r.Status != DraftStatus.Stale).ToList();
        if (replies.Count == 0) return session;

        var total = replies.Count;
        progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Started, 0, total));

        var snapshot = await InvokeAsync(SubmitStep.AttachReplies, 0, total, session, progress,
            () => _submitter.FindOwnPendingReviewAsync(reference, ct)).ConfigureAwait(false);
        if (snapshot is null)
        {
            // The pending review exists (Step 1 found it / Begin created it) but the re-fetch came
            // back null — GitHub's reviews(...) list lagging. Treat as a retryable step failure; do
            // NOT demote replies as if their parent threads were deleted (a transient null must not
            // permanently strand the user's replies). Emit the terminal Failed for the Started above.
            const string msg = "could not fetch the pending-review snapshot to reconcile replies; retry";
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Failed, 0, total, msg));
            throw new SubmitFailedException(SubmitStep.AttachReplies, msg, session);
        }

        var current = session;
        var done = 0;
        foreach (var reply in replies)
        {
            var parent = snapshot.Threads.FirstOrDefault(t => string.Equals(t.PullRequestReviewThreadId, reply.ParentThreadId, StringComparison.Ordinal));

            if (reply.ReplyCommentId is not null)
            {
                var stillThere = parent is not null
                    && parent.Comments.Any(c => string.Equals(c.CommentId, reply.ReplyCommentId, StringComparison.Ordinal));
                if (stillThere)
                {
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                // Falls through to recreate (the comment was deleted on github.com).
            }
            else
            {
                var markered = MarkeredReplies(parent, reply.Id);
                if (markered.Count == 1)
                {
                    var adoptedId = markered[0].CommentId;
                    current = StampReplyCommentId(current, reply.Id, adoptedId);
                    await PersistOrFailAsync(SubmitStep.AttachReplies, current, progress,
                        st => StampReplyCommentIdOverlay(st, sessionKey, reply.Id, adoptedId), ct).ConfigureAwait(false);
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                if (markered.Count > 1)
                {
                    // Reply multi-marker-match: adopt one (the lowest comment id — PendingReviewCommentSnapshot
                    // carries no createdAt, and the choice is cosmetic anyway: there is no delete-comment
                    // capability on IReviewSubmitter, so the duplicates can't be cleaned up; surface the
                    // situation through the onDuplicateMarker notice). The adopted reply still lands on
                    // github.com once Finalize runs; the leftover duplicates are visible on the PR after submit.
                    var earliest = markered[0];
                    current = StampReplyCommentId(current, reply.Id, earliest.CommentId);
                    await PersistOrFailAsync(SubmitStep.AttachReplies, current, progress,
                        st => StampReplyCommentIdOverlay(st, sessionKey, reply.Id, earliest.CommentId), ct).ConfigureAwait(false);
                    _onDuplicateMarker?.Invoke(
                        $"reply {reply.Id}: {markered.Count} server comments carried its marker; adopted {earliest.CommentId} (duplicates can't be auto-removed)");
                    progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, ++done, total));
                    continue;
                }
                // Falls through to create.
            }

            // Parent thread deleted by its author between submit attempts (snapshot already knows).
            if (parent is null)
            {
                current = await DemoteReplyAndPersistAsync(sessionKey, current, reply.Id, done, total, progress, ct).ConfigureAwait(false);
                throw new SubmitFailedException(SubmitStep.AttachReplies,
                    $"reply {reply.Id}: parent thread {reply.ParentThreadId} no longer exists on the pending review", current);
            }

            var bodyWithMarker = PipelineMarker.Inject(reply.BodyMarkdown, reply.Id);
            AttachReplyResult result;
            try
            {
                result = await _submitter.AttachReplyAsync(reference, pendingReviewId, reply.ParentThreadId, bodyWithMarker, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (SubmitFailedException)
            {
                throw;
            }
            catch (Exception ex) when (IsParentThreadGone(ex))
            {
                current = await DemoteReplyAndPersistAsync(sessionKey, current, reply.Id, done, total, progress, ct).ConfigureAwait(false);
                throw new SubmitFailedException(SubmitStep.AttachReplies,
                    $"reply {reply.Id}: parent thread {reply.ParentThreadId} no longer exists on the pending review", current, ex);
            }
#pragma warning disable CA1031 // any other adapter/transport exception is a retryable step failure
            catch (Exception ex)
            {
                progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Failed, done, total, ex.Message));
                throw new SubmitFailedException(SubmitStep.AttachReplies, ex.Message, current, ex);
            }
#pragma warning restore CA1031

            current = StampReplyCommentId(current, reply.Id, result.CommentId);
            await PersistOrFailAsync(SubmitStep.AttachReplies, current, progress,
                st => StampReplyCommentIdOverlay(st, sessionKey, reply.Id, result.CommentId), ct).ConfigureAwait(false);
            progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Succeeded, ++done, total));
        }

        return current;
    }

    private async Task<ReviewSessionState> DemoteReplyAndPersistAsync(
        string sessionKey, ReviewSessionState current, string replyId, int done, int total,
        IProgress<SubmitProgressEvent> progress, CancellationToken ct)
    {
        var demoted = DemoteReplyToStale(current, replyId);
        await PersistOrFailAsync(SubmitStep.AttachReplies, demoted, progress,
            st => DemoteReplyToStaleOverlay(st, sessionKey, replyId), ct).ConfigureAwait(false);
        progress.Report(new SubmitProgressEvent(SubmitStep.AttachReplies, SubmitStepStatus.Failed, done, total, "parent thread deleted"));
        return demoted;
    }

    // Comments on the parent thread whose marker matches replyId, ordered by comment id. This is an
    // *approximate* "earliest first" — GitHub node ids aren't guaranteed to sort by creation time,
    // and PendingReviewCommentSnapshot carries no createdAt (the adapter has it but doesn't surface
    // it). The multi-match adopt-which is cosmetic anyway: reply duplicates can't be auto-removed
    // (no delete-comment capability on IReviewSubmitter), so all of them stay on the PR after submit.
    private static List<PendingReviewCommentSnapshot> MarkeredReplies(PendingReviewThreadSnapshot? parent, string replyId)
        => parent is null
            ? new List<PendingReviewCommentSnapshot>()
            : parent.Comments
                .Where(c => string.Equals(PipelineMarker.Extract(c.BodyMarkdown), replyId, StringComparison.Ordinal))
                .OrderBy(c => c.CommentId, StringComparer.Ordinal)
                .ToList();

    // TODO: this matches the InMemoryReviewSubmitter fake's "NOT_FOUND: parent thread …" message,
    // not GitHub's actual GraphQL error shape — GitHubGraphQLException puts the error text in
    // ErrorsJson, not Message, and PRism.Core can't reference that type. In production the snapshot
    // `parent is null` branch (Step 4 re-fetches before AttachReplyAsync) catches a genuinely-deleted
    // parent, and a deletion that races the call self-heals on the next attempt via that branch — so
    // a false negative here is a slightly cryptic first-attempt message, not a stranded reply. A
    // typed not-found exception in PRism.Core, thrown by the adapter, is the proper fix (deferred).
    private static bool IsParentThreadGone(Exception ex)
        => ex.Message.Contains("NOT_FOUND", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("parent thread", StringComparison.OrdinalIgnoreCase)
        || ex.Message.Contains("could not be found", StringComparison.OrdinalIgnoreCase);

    // Wraps an IReviewSubmitter (or head-sha) call so any adapter/transport failure becomes a
    // SubmitFailedException carrying the step + the session as it stands at the failure, plus emits
    // a Failed progress event. Mirrors DraftReconciliationPipeline's broad-catch-after-OCE pattern.
    private static async Task<T> InvokeAsync<T>(
        SubmitStep step, int done, int total, ReviewSessionState sessionAtFailure,
        IProgress<SubmitProgressEvent> progress, Func<Task<T>> call)
    {
        try
        {
            return await call().ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (SubmitFailedException)
        {
            throw;
        }
#pragma warning disable CA1031 // any adapter/transport exception is, by design, a retryable step failure
        catch (Exception ex)
        {
            progress.Report(new SubmitProgressEvent(step, SubmitStepStatus.Failed, done, total, ex.Message));
            throw new SubmitFailedException(step, ex.Message, sessionAtFailure, ex);
        }
#pragma warning restore CA1031
    }

    private static async Task InvokeAsync(
        SubmitStep step, int done, int total, ReviewSessionState sessionAtFailure,
        IProgress<SubmitProgressEvent> progress, Func<Task> call)
        => await InvokeAsync<object?>(step, done, total, sessionAtFailure, progress, async () =>
        {
            await call().ConfigureAwait(false);
            return null;
        }).ConfigureAwait(false);

    // ---- Per-stamp persistence (overlay UpdateAsync on the current session) ----

    // Persists an overlay transform — re-reading the session under sessionKey and editing only the
    // field in question, so a PUT /draft from another tab that committed between the pipeline's
    // snapshot-load and this call is not clobbered (revision R1 / adversarial #4). On a store failure
    // (read-only mode, disk error) translates the exception into a SubmitFailedException at `step` —
    // so SubmitAsync still returns SubmitOutcome.Failed (with the at-failure session the endpoint
    // should persist) rather than letting the exception escape and break the "returns an outcome"
    // contract. (The success-path clear is intentionally NOT routed through here — see SubmitAsync.)
    private async Task PersistOrFailAsync(
        SubmitStep step, ReviewSessionState sessionAtFailure, IProgress<SubmitProgressEvent> progress,
        Func<AppState, AppState> transform, CancellationToken ct)
    {
        try
        {
            await _stateStore.UpdateAsync(transform, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (SubmitFailedException)
        {
            throw;
        }
#pragma warning disable CA1031 // any store/disk failure is, by design, a retryable step failure
        catch (Exception ex)
        {
            progress.Report(new SubmitProgressEvent(step, SubmitStepStatus.Failed, 0, 0, ex.Message));
            throw new SubmitFailedException(step, $"failed to persist {step} progress to state.json: {ex.Message}", sessionAtFailure, ex);
        }
#pragma warning restore CA1031
    }

    // ---- Overlay transforms (run inside AppStateStore.UpdateAsync) ----

    private static AppState StampPendingReview(AppState state, string sessionKey, string pendingReviewId, string commitOid)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        return WithSession(state, sessionKey, cur with { PendingReviewId = pendingReviewId, PendingReviewCommitOid = commitOid });
    }

    private static AppState StampDraftThreadIdOverlay(AppState state, string sessionKey, string draftId, string threadId)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var drafts = cur.DraftComments.Select(d => string.Equals(d.Id, draftId, StringComparison.Ordinal) ? d with { ThreadId = threadId } : d).ToList();
        return WithSession(state, sessionKey, cur with { DraftComments = drafts });
    }

    private static AppState StampReplyCommentIdOverlay(AppState state, string sessionKey, string replyId, string commentId)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var replies = cur.DraftReplies.Select(r => string.Equals(r.Id, replyId, StringComparison.Ordinal) ? r with { ReplyCommentId = commentId } : r).ToList();
        return WithSession(state, sessionKey, cur with { DraftReplies = replies });
    }

    private static AppState DemoteReplyToStaleOverlay(AppState state, string sessionKey, string replyId)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var replies = cur.DraftReplies.Select(r => string.Equals(r.Id, replyId, StringComparison.Ordinal) ? r with { Status = DraftStatus.Stale } : r).ToList();
        return WithSession(state, sessionKey, cur with { DraftReplies = replies });
    }

    private static AppState ClearPendingReviewStamps(AppState state, string sessionKey)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var cleared = cur with
        {
            PendingReviewId = null,
            PendingReviewCommitOid = null,
            DraftComments = cur.DraftComments.Select(d => d.ThreadId is null ? d : d with { ThreadId = null }).ToList(),
            DraftReplies = cur.DraftReplies.Select(r => r.ReplyCommentId is null ? r : r with { ReplyCommentId = null }).ToList(),
        };
        return WithSession(state, sessionKey, cleared);
    }

    private static AppState ClearSubmittedSession(AppState state, string sessionKey)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        var cleared = cur with
        {
            PendingReviewId = null,
            PendingReviewCommitOid = null,
            DraftComments = new List<DraftComment>(),
            DraftReplies = new List<DraftReply>(),
            DraftSummaryMarkdown = null,
            DraftVerdict = null,
            DraftVerdictStatus = DraftVerdictStatus.Draft,
        };
        return WithSession(state, sessionKey, cleared);
    }

    private static AppState WithSession(AppState state, string sessionKey, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = session };
        return state with { Reviews = state.Reviews with { Sessions = sessions } };
    }

    // ---- Pure transforms on the in-pipeline working snapshot (the value SubmitAsync threads
    // through Steps 3-5; mirrors the overlay so the working snapshot and the persisted session
    // stay in lockstep) ----

    private static ReviewSessionState StampDraftThreadId(ReviewSessionState session, string draftId, string threadId)
        => session with
        {
            DraftComments = session.DraftComments
                .Select(d => string.Equals(d.Id, draftId, StringComparison.Ordinal) ? d with { ThreadId = threadId } : d)
                .ToList(),
        };

    private static ReviewSessionState StampReplyCommentId(ReviewSessionState session, string replyId, string commentId)
        => session with
        {
            DraftReplies = session.DraftReplies
                .Select(r => string.Equals(r.Id, replyId, StringComparison.Ordinal) ? r with { ReplyCommentId = commentId } : r)
                .ToList(),
        };

    private static ReviewSessionState DemoteReplyToStale(ReviewSessionState session, string replyId)
        => session with
        {
            DraftReplies = session.DraftReplies
                .Select(r => string.Equals(r.Id, replyId, StringComparison.Ordinal) ? r with { Status = DraftStatus.Stale } : r)
                .ToList(),
        };
}
