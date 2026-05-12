using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

using PRism.Core;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit;
using PRism.Core.Submit.Pipeline;
using PRism.Web.Submit;

namespace PRism.Web.Endpoints;

// S5 PR3 — the submit pipeline behind HTTP (spec § 7):
//  - POST /api/pr/{ref}/submit                                  → drive SubmitPipeline; 409 on lock contention
//  - POST /api/pr/{ref}/submit/foreign-pending-review/resume    → TOCTOU re-fetch + import the foreign review as drafts
//  - POST /api/pr/{ref}/submit/foreign-pending-review/discard   → TOCTOU re-fetch + deletePullRequestReview
//
// Authorization is the broader-than-spec `cache.IsSubscribed(prRef)` pattern (same as markAllRead /
// reload; S4 deferral 6 stays deferred — PoC threat model per spec § 6.2). Body-size caps for all
// three routes are wired via the pre-routing UseWhen middleware in Program.cs.
internal static class PrSubmitEndpoints
{
    // FieldsTouched lists for the StateChanged events this endpoint publishes. The frontend
    // re-fetches the whole session on state-changed regardless; these are informational.
    private static readonly string[] SubmittedFields = { "draft-comments", "draft-replies", "draft-summary", "draft-verdict", "draft-verdict-status", "pending-review" };
    private static readonly string[] PendingReviewFields = { "pending-review", "draft-comments", "draft-replies" };

    private static readonly Action<ILogger, string, Exception?> s_pipelineThrew =
        LoggerMessage.Define<string>(LogLevel.Error, new EventId(0, "SubmitPipelineThrew"),
            "Submit pipeline threw outside its outcome contract for {SessionKey}");

    public static IEndpointRouteBuilder MapPrSubmitEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit", SubmitAsync);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/resume", ResumeForeignPendingReviewAsync);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/discard", DiscardForeignPendingReviewAsync);
        return app;
    }

    // ------------------------------------------------------------------ POST /submit

    private static async Task<IResult> SubmitAsync(
        string owner, string repo, int number,
        SubmitRequestDto? request,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IPrReader prReader,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        IHostApplicationLifetime appLifetime,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before submitting."), statusCode: StatusCodes.Status401Unauthorized);

        if (!TryParseVerdict(request?.Verdict, out var verdict))
            return Results.Json(new SubmitErrorDto("verdict-invalid", "verdict must be Approve, RequestChanges, or Comment."), statusCode: StatusCodes.Status400BadRequest);

        // --- Defensive rule enforcement (server-side authoritative; spec § 7.1 + § 9 rules b/c/e/f).
        // The Submit Review button enforces the same rules client-side; this is the backstop.
        var appState = await stateStore.LoadAsync(ct).ConfigureAwait(false);
        if (!appState.Reviews.Sessions.TryGetValue(sessionKey, out var session))
            return Results.Json(new SubmitErrorDto("no-session", "No draft session for this PR."), statusCode: StatusCodes.Status400BadRequest);

        // Rule (b): any non-overridden Stale draft / reply blocks submit.
        if (session.DraftComments.Any(d => d.Status == DraftStatus.Stale && !d.IsOverriddenStale)
            || session.DraftReplies.Any(r => r.Status == DraftStatus.Stale && !r.IsOverriddenStale))
            return Results.Json(new SubmitErrorDto("stale-drafts", "Resolve stale drafts before submitting."), statusCode: StatusCodes.Status400BadRequest);

        // Rule (c): verdict re-confirmation pending.
        if (session.DraftVerdictStatus == DraftVerdictStatus.NeedsReconfirm)
            return Results.Json(new SubmitErrorDto("verdict-needs-reconfirm", "Verdict requires re-confirmation."), statusCode: StatusCodes.Status400BadRequest);

        // Rule (e): a Comment-verdict review needs at least one draft / reply / non-empty summary.
        if (verdict == SubmitEvent.Comment
            && session.DraftComments.Count == 0
            && session.DraftReplies.Count == 0
            && string.IsNullOrWhiteSpace(session.DraftSummaryMarkdown))
            return Results.Json(new SubmitErrorDto("no-content", "A Comment-verdict review needs at least one draft, reply, or summary."), statusCode: StatusCodes.Status400BadRequest);

        // Rule (f): head_sha drift. Compare the session's last-viewed head against the most recent
        // active-PR poll snapshot (when one exists). Also require a known last-viewed head so the
        // pipeline always Begins against a real commit oid.
        if (string.IsNullOrEmpty(session.LastViewedHeadSha))
            return Results.Json(new SubmitErrorDto("head-sha-drift", "Reload the PR before submitting."), statusCode: StatusCodes.Status400BadRequest);
        var pollSnapshot = activePrCache.GetCurrent(prRef);
        if (pollSnapshot is not null && !string.Equals(pollSnapshot.HeadSha, session.LastViewedHeadSha, StringComparison.Ordinal))
            return Results.Json(new SubmitErrorDto("head-sha-drift", "Reload the PR before submitting."), statusCode: StatusCodes.Status400BadRequest);

        // --- Per-PR submit lock. NOT `await using` — the lock must remain held for the duration of
        // the fire-and-forget pipeline; the Task.Run lambda's finally is the sole release site, so
        // ownership transfers there. CA2000 can't see the cross-task transfer; suppressed deliberately.
#pragma warning disable CA2000
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit is already in flight for this PR."), statusCode: StatusCodes.Status409Conflict);

        var headSha = session.LastViewedHeadSha;
        var progress = new SseSubmitProgressBridge(prRef, bus);
        var pipeline = new SubmitPipeline(
            submitter,
            stateStore,
            onDuplicateMarker: msg => bus.Publish(new SubmitDuplicateMarkerDetectedBusEvent(prRef, ExtractDraftId(msg))),
            getCurrentHeadShaAsync: async token =>
            {
                var snap = await prReader.PollActivePrAsync(prRef, token).ConfigureAwait(false);
                return snap.HeadSha;
            });

        // Fire-and-forget. CRITICAL: pass CancellationToken.None to Task.Run and the host's
        // ApplicationStopping (NOT the request `ct`) into the pipeline — the request `ct` is bound
        // to HttpContext.RequestAborted, which fires the moment the 200 response completes (or the
        // tab closes), which would silently kill the pipeline mid-run.
        var pipelineCt = appLifetime.ApplicationStopping;
        _ = Task.Run(async () =>
        {
            try
            {
                var outcome = await pipeline.SubmitAsync(prRef, session, verdict, headSha, progress, pipelineCt).ConfigureAwait(false);
                switch (outcome)
                {
                    case SubmitOutcome.Success:
                        // Publish OUTSIDE _gate after the pipeline's success-clear ran (spec § 5.2 step 5 / § 17 #25).
                        bus.Publish(new DraftSubmitted(prRef));
                        bus.Publish(new StateChanged(prRef, SubmittedFields, SourceTabId: null));
                        break;
                    case SubmitOutcome.Failed failed:
                        // The terminal submit-progress SSE event (Status=Failed) already fired via the
                        // bridge. Defensively persist the at-failure session (carries the Begin stamp for
                        // the begin-persist-failed case; idempotent otherwise — the per-step overlays
                        // already ran) and publish StateChanged so the frontend picks up any stamped
                        // PendingReviewId / ThreadId for the in-flight-recovery surface.
                        await stateStore.UpdateAsync(state => WithSession(state, sessionKey, failed.NewSession), pipelineCt).ConfigureAwait(false);
                        bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));
                        break;
                    case SubmitOutcome.ForeignPendingReviewPromptRequired prompt:
                        var s = prompt.Snapshot;
                        bus.Publish(new SubmitForeignPendingReviewBusEvent(
                            prRef, s.PullRequestReviewId, s.CommitOid, s.CreatedAt,
                            ThreadCount: s.Threads.Count,
                            ReplyCount: s.Threads.Sum(t => t.Comments.Count)));
                        break;
                    case SubmitOutcome.StaleCommitOidRecreating stale:
                        // The pipeline already deleted the orphan + cleared the session's pending stamps.
                        bus.Publish(new SubmitStaleCommitOidBusEvent(prRef, stale.OrphanCommitOid));
                        bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));
                        break;
                }
            }
            catch (OperationCanceledException) when (pipelineCt.IsCancellationRequested)
            {
                // Host shutting down — per-step persists already wrote; the next session resumes via
                // the foreign-pending-review flow if a pending review exists on github.com.
            }
#pragma warning disable CA1031 // a stray exception in a fire-and-forget background task must not crash the host
            catch (Exception ex)
            {
                // SubmitAsync's contract returns SubmitOutcome.Failed for step failures; reaching here
                // means a store crash / programming error. Log and swallow — re-throwing would only
                // surface an unobserved-task exception.
                s_pipelineThrew(loggerFactory.CreateLogger("PRism.Web.Endpoints.PrSubmitEndpoints"), sessionKey, ex);
            }
#pragma warning restore CA1031
            finally
            {
                await handle.DisposeAsync().ConfigureAwait(false);
            }
        }, CancellationToken.None);

        return Results.Json(new SubmitResponseDto("started"));
    }

    // ----------------------------------------- POST /submit/foreign-pending-review/resume

    private static async Task<IResult> ResumeForeignPendingReviewAsync(
        string owner, string repo, int number,
        ForeignPendingReviewActionDto? request,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IPrReader prReader,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before resuming."), statusCode: StatusCodes.Status401Unauthorized);
        if (string.IsNullOrEmpty(request?.PullRequestReviewId))
            return Results.Json(new SubmitErrorDto("pull-request-review-id-missing", "pullRequestReviewId is required."), statusCode: StatusCodes.Status400BadRequest);

        // TOCTOU defense — re-fetch Snapshot B; reject if the pending review changed during the prompt.
        var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
        if (snapshotB is null || !string.Equals(snapshotB.PullRequestReviewId, request.PullRequestReviewId, StringComparison.Ordinal))
            return Results.Json(new SubmitErrorDto("pending-review-state-changed", "The pending review changed during the prompt. Please retry submit."), statusCode: StatusCodes.Status409Conflict);

        // Import each thread as a DraftComment (Status=Draft, ThreadId stamped); reply chains as
        // DraftReply (ReplyCommentId stamped). Bodies have all PRism marker prefixes stripped (R8).
        // OriginalLineContent is enriched from the file content at OriginalCommitOid (R7) — an empty
        // anchor poisons reconciliation, so a fetch failure imports the draft Stale instead.
        var newDrafts = new List<DraftComment>(snapshotB.Threads.Count);
        var newReplies = new List<DraftReply>();
        foreach (var t in snapshotB.Threads)
        {
            var (anchoredLine, status) = await EnrichAnchoredLineAsync(prReader, prRef, t, ct).ConfigureAwait(false);
            newDrafts.Add(new DraftComment(
                Id: Guid.NewGuid().ToString(),
                FilePath: t.FilePath,
                LineNumber: t.LineNumber,
                Side: t.Side,
                AnchoredSha: t.OriginalCommitOid,
                AnchoredLineContent: anchoredLine,
                BodyMarkdown: PipelineMarker.StripAllMarkerPrefixes(PipelineMarker.StripIfPresent(t.BodyMarkdown)),
                Status: status,
                IsOverriddenStale: false,
                ThreadId: t.PullRequestReviewThreadId));
            foreach (var c in t.Comments)
            {
                newReplies.Add(new DraftReply(
                    Id: Guid.NewGuid().ToString(),
                    ParentThreadId: t.PullRequestReviewThreadId,
                    ReplyCommentId: c.CommentId,
                    BodyMarkdown: PipelineMarker.StripAllMarkerPrefixes(PipelineMarker.StripIfPresent(c.BodyMarkdown)),
                    Status: DraftStatus.Draft,
                    IsOverriddenStale: false));
            }
        }

        await stateStore.UpdateAsync(state =>
        {
            var existing = state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? s : EmptySession();
            var merged = existing with
            {
                DraftComments = existing.DraftComments.Concat(newDrafts).ToList(),
                DraftReplies = existing.DraftReplies.Concat(newReplies).ToList(),
                PendingReviewId = snapshotB.PullRequestReviewId,
                PendingReviewCommitOid = snapshotB.CommitOid,
            };
            return WithSession(state, sessionKey, merged);
        }, ct).ConfigureAwait(false);

        bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));

        // 200 carries the full Snapshot B payload (thread + reply bodies + counts + per-thread
        // IsResolved) so the frontend renders the imported drafts immediately and computes the
        // Snapshot A → Snapshot B count-staleness note client-side (§ 11.1).
        return Results.Json(new
        {
            pullRequestReviewId = snapshotB.PullRequestReviewId,
            commitOid = snapshotB.CommitOid,
            createdAt = snapshotB.CreatedAt.ToString("O"),
            threadCount = snapshotB.Threads.Count,
            replyCount = snapshotB.Threads.Sum(t => t.Comments.Count),
            threads = snapshotB.Threads.Select(t => new
            {
                id = t.PullRequestReviewThreadId,
                filePath = t.FilePath,
                lineNumber = t.LineNumber,
                side = t.Side,
                isResolved = t.IsResolved,
                body = PipelineMarker.StripAllMarkerPrefixes(PipelineMarker.StripIfPresent(t.BodyMarkdown)),
                replies = t.Comments.Select(c => new
                {
                    id = c.CommentId,
                    body = PipelineMarker.StripAllMarkerPrefixes(PipelineMarker.StripIfPresent(c.BodyMarkdown)),
                }).ToList(),
            }).ToList(),
        });
    }

    // ----------------------------------------- POST /submit/foreign-pending-review/discard

    private static async Task<IResult> DiscardForeignPendingReviewAsync(
        string owner, string repo, int number,
        ForeignPendingReviewActionDto? request,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        if (!activePrCache.IsSubscribed(prRef))
            return Results.Json(new SubmitErrorDto("unauthorized", "Subscribe to this PR before discarding."), statusCode: StatusCodes.Status401Unauthorized);
        if (string.IsNullOrEmpty(request?.PullRequestReviewId))
            return Results.Json(new SubmitErrorDto("pull-request-review-id-missing", "pullRequestReviewId is required."), statusCode: StatusCodes.Status400BadRequest);

        var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
        if (snapshotB is null || !string.Equals(snapshotB.PullRequestReviewId, request.PullRequestReviewId, StringComparison.Ordinal))
            return Results.Json(new SubmitErrorDto("pending-review-state-changed", "The pending review changed during the prompt. Please retry submit."), statusCode: StatusCodes.Status409Conflict);

        await submitter.DeletePendingReviewAsync(prRef, snapshotB.PullRequestReviewId, ct).ConfigureAwait(false);

        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
            return WithSession(state, sessionKey, existing with { PendingReviewId = null, PendingReviewCommitOid = null });
        }, ct).ConfigureAwait(false);

        bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));
        return Results.Ok();
    }

    // ------------------------------------------------------------------ helpers

    private static bool TryParseVerdict(string? s, out SubmitEvent verdict)
    {
        switch (s)
        {
            case "Approve": verdict = SubmitEvent.Approve; return true;
            case "RequestChanges": verdict = SubmitEvent.RequestChanges; return true;
            case "Comment": verdict = SubmitEvent.Comment; return true;
            default: verdict = SubmitEvent.Comment; return false;
        }
    }

    // Slices line `t.LineNumber` (1-indexed) out of the file content at OriginalCommitOid for use
    // as the imported draft's AnchoredLineContent. Returns (line, Draft) on success; ("", Stale) if
    // the commit is unreachable or the line is out of range — an empty anchor on a Draft would let
    // reconciliation match every blank line, so a fetch failure imports the draft Stale instead.
    private static async Task<(string AnchoredLine, DraftStatus Status)> EnrichAnchoredLineAsync(
        IPrReader prReader, PrReference prRef, PendingReviewThreadSnapshot t, CancellationToken ct)
    {
        if (string.IsNullOrEmpty(t.OriginalCommitOid)) return ("", DraftStatus.Stale);
        FileContentResult fc;
        try
        {
            fc = await prReader.GetFileContentAsync(prRef, t.FilePath, t.OriginalCommitOid, ct).ConfigureAwait(false);
        }
#pragma warning disable CA1031 // a transport failure fetching the anchor line falls back to importing the draft Stale
        catch (Exception)
        {
            return ("", DraftStatus.Stale);
        }
#pragma warning restore CA1031
        if (fc.Status != FileContentStatus.Ok || fc.Content is null) return ("", DraftStatus.Stale);
        var lines = fc.Content.Split('\n');
        if (t.LineNumber < 1 || t.LineNumber > lines.Length) return ("", DraftStatus.Stale);
        return (lines[t.LineNumber - 1], DraftStatus.Draft);
    }

    private static AppState WithSession(AppState state, string sessionKey, ReviewSessionState session)
    {
        var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions) { [sessionKey] = session };
        return state with { Reviews = state.Reviews with { Sessions = sessions } };
    }

    private static ReviewSessionState EmptySession() => new(
        LastViewedHeadSha: null, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: Array.Empty<DraftComment>(),
        DraftReplies: Array.Empty<DraftReply>(),
        DraftSummaryMarkdown: null, DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    // The pipeline's onDuplicateMarker notices look like "draft <id>: …" or "reply <id>: …". Pull
    // the id out for the submit-duplicate-marker-detected SSE payload; "unknown" if we can't.
    private static string ExtractDraftId(string msg)
    {
        if (string.IsNullOrEmpty(msg)) return "unknown";
        foreach (var prefix in new[] { "draft ", "reply " })
        {
            if (msg.StartsWith(prefix, StringComparison.Ordinal))
            {
                var rest = msg.AsSpan(prefix.Length);
                var end = rest.IndexOf(':');
                return (end < 0 ? rest : rest[..end]).Trim().ToString();
            }
        }
        return "unknown";
    }
}
