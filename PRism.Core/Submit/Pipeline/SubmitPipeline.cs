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
                    // Surface "Recreating against new head sha…" before the destructive call, then
                    // delete the orphan, clear the session's pending state + every stamp, and hand
                    // the StaleCommitOidRecreating outcome back; the endpoint persists nothing more
                    // (the clear already happened here) and the user re-confirms / re-runs.
                    progress.Report(new SubmitProgressEvent(SubmitStep.DetectExistingPendingReview, SubmitStepStatus.Started, 0, 0));
                    await InvokeAsync(SubmitStep.DetectExistingPendingReview, 0, 0, session, progress,
                        () => _submitter.DeletePendingReviewAsync(reference, existing.PullRequestReviewId, ct)).ConfigureAwait(false);
                    await _stateStore.UpdateAsync(state => ClearPendingReviewStamps(state, sessionKey), ct).ConfigureAwait(false);
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

            // ---- Steps 3 + 4 — attach threads / replies (Tasks 27-28) ----
            // For the empty pipeline (DraftComments / DraftReplies empty) spec § 5.2 skips both
            // steps entirely. The thread/reply attach loops land in the next tasks; until then the
            // pipeline supports the empty-PR + summary-only case (DoD test (a)) and resume of an
            // already-attached review.
            // (Tasks 27-28 insert: workingSession = await StepAttachThreadsAsync(reference, sessionKey,
            //  pendingReviewId, workingSession, existing, progress, ct); ... StepAttachRepliesAsync(...);
            //  Step 3 reuses `existing` as the detection snapshot for its stamped-thread verify branch.)

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
            await _stateStore.UpdateAsync(state => ClearSubmittedSession(state, sessionKey), ct).ConfigureAwait(false);

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

        await _stateStore.UpdateAsync(state => StampPendingReview(state, sessionKey, result.PullRequestReviewId, currentHeadSha), ct).ConfigureAwait(false);
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

    // ---- Overlay transforms (run inside AppStateStore.UpdateAsync) ----

    private static AppState StampPendingReview(AppState state, string sessionKey, string pendingReviewId, string commitOid)
    {
        if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var cur)) return state;
        return WithSession(state, sessionKey, cur with { PendingReviewId = pendingReviewId, PendingReviewCommitOid = commitOid });
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
}
