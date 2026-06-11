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

// Exposed as internal so integration tests can inject a shorter timeout to make the 504 path
// testable without a real 30-second wait.
// NOTE: This is a test-only timing seam. PrSubmitDiscardEndpointTests mutates LockAcquireTimeout
// and is placed in [Collection("SubmitDiscardSerial")] to ensure no other test class races the mutation.
internal static class DiscardTimeouts
{
    // Discard waits up to this long for the cancelled pipeline to release the submit lock.
    // 30 s in production; tests override to a much shorter value via the internal setter.
    internal static TimeSpan LockAcquireTimeout { get; set; } = TimeSpan.FromSeconds(30);
}

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
    // Single source of the ILogger category so the literal isn't duplicated at
    // every site (PR #55 doubled the count from 2 to 4 — refactored here).
    private static readonly string LoggerCategory = typeof(PrSubmitEndpoints).FullName!;

    // FieldsTouched lists for the StateChanged events this endpoint publishes. The frontend
    // re-fetches the whole session on state-changed regardless; these are informational.
    private static readonly string[] SubmittedFields = { "draft-comments", "draft-replies", "draft-verdict", "draft-verdict-status", "pending-review" };
    private static readonly string[] PendingReviewFields = { "pending-review", "draft-comments", "draft-replies" };

    private static readonly Action<ILogger, string, Exception?> s_pipelineThrew =
        LoggerMessage.Define<string>(LogLevel.Error, new EventId(0, "SubmitPipelineThrew"),
            "Submit pipeline threw outside its outcome contract for {SessionKey}");

    private static readonly Action<ILogger, string, Exception?> s_foreignDiscardDeleteFailed =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(1, "ForeignPendingReviewDiscardDeleteFailed"),
            "deletePullRequestReview failed for the foreign-pending-review discard on {SessionKey} (returning 502); the pending review remains and will be re-detected on the next submit");

    private static readonly Action<ILogger, string, Exception?> s_ownDiscardGitHubFailed =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(5, "OwnPendingReviewDiscardGitHubFailed"),
            "POST /submit/discard failed with a GitHub network error for {SessionKey}");

    // Logged at Warning because TabStamps[callerTabId] missing is a server-detectable FE wire-up
    // gap — the caller's tab never sent /mark-viewed after loading PR detail. Without this log,
    // the symptom — silent flash of the submit button — required client-side debugging to
    // diagnose. The FE wire-up lives in usePrDetail; the log message stays terse on the response
    // body so an unauthenticated viewer can't infer the route shape from the error payload.
    private static readonly Action<ILogger, string, Exception?> s_headShaNotStamped =
        LoggerMessage.Define<string>(LogLevel.Warning, new EventId(2, "SubmitRejectedHeadShaNotStamped"),
            "POST /submit rejected for {SessionKey}: session.TabStamps for the caller's tab is missing. The frontend must call POST /api/pr/{{ref}}/mark-viewed when PR detail loads; see PrDetailEndpoints.MarkViewed.");

    // Logged at Information because real drift is a UX concern (the user's
    // viewport is stale), not a wire-up bug. Surfacing it lets operators
    // distinguish "user took too long" from "wire-up regressed."
    private static readonly Action<ILogger, string, string, string, Exception?> s_headShaDrift =
        LoggerMessage.Define<string, string, string>(LogLevel.Information, new EventId(3, "SubmitRejectedHeadShaDrift"),
            "POST /submit rejected for {SessionKey}: head SHA drifted (last viewed {LastViewed}, current {Current}). The user must Reload before retrying.");

    // Logged at Information — cancellation is an expected user-initiated action (discard), not a
    // failure. EventId 4 (0–3 taken above; 5 used by s_ownDiscardGitHubFailed).
    private static readonly Action<ILogger, string, string, Exception?> s_pipelineCancelled =
        LoggerMessage.Define<string, string>(LogLevel.Information, new EventId(4, "SubmitPipelineCancelled"),
            "Submit pipeline cancelled for {SessionKey}: {Reason}");

    public static IEndpointRouteBuilder MapPrSubmitEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit", SubmitAsync);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/discard", DiscardOwnPendingReviewAsync);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/resume", ResumeForeignPendingReviewAsync);
        app.MapPost("/api/pr/{owner}/{repo}/{number:int}/submit/foreign-pending-review/discard", DiscardForeignPendingReviewAsync);
        return app;
    }

    // ------------------------------------------------------------------ POST /submit

    private static async Task<IResult> SubmitAsync(
        string owner, string repo, int number,
        SubmitRequestDto? request,
        HttpContext httpContext,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IPrReader prReader,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        SubmitCancellationRegistry cancellationRegistry,
        IHostApplicationLifetime appLifetime,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        if (RequireSubscribed.Check(activePrCache, prRef) is { } notSubscribed)
            return notSubscribed;

        if (!TryParseVerdict(request?.Verdict, out var verdict))
            return Results.Json(new SubmitErrorDto("verdict-invalid", "verdict must be approve, request-changes, or comment."), statusCode: StatusCodes.Status400BadRequest);

        // Tab id validation (spec § 3 + § 5.5) — the caller's tab is the principal for the
        // head-sha drift gate below. Surface a distinct "tab-id-missing" 422 (vs the 400
        // "head-sha-not-stamped" the empty-stamp case still emits) so the frontend can
        // distinguish a missing/poisoned tab id (reload the tab) from a wire-up gap (call
        // /mark-viewed). The allowlist is the same shared regex as mark-viewed / reload.
        var tabId = httpContext.Request.Headers[TabStamps.TabIdHeader].FirstOrDefault();
        if (string.IsNullOrEmpty(tabId) || !PrDetailEndpoints.TabIdAllowlistRegex().IsMatch(tabId))
            return Results.Json(new SubmitErrorDto("tab-id-missing", "Reload this browser tab and try again."),
                statusCode: StatusCodes.Status422UnprocessableEntity);

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

        // Rule (e): a Comment-verdict review needs at least one draft or reply. Under V7 a non-empty
        // PR-root summary is materialised as a DraftComment (no FilePath / no LineNumber), so the
        // legacy `&& DraftSummaryMarkdown empty` clause is now subsumed by `DraftComments.Count == 0`.
        if (verdict == SubmitEvent.Comment
            && session.DraftComments.Count == 0
            && session.DraftReplies.Count == 0)
            return Results.Json(new SubmitErrorDto("no-content", "A Comment-verdict review needs at least one draft, reply, or summary."), statusCode: StatusCodes.Status400BadRequest);

        // Rule (f): head_sha drift. Two distinct sub-cases — kept separate so the frontend's
        // toast can pick a useful remedy, and so a wire-up regression (FE never stamping the
        // per-tab head sha via /mark-viewed) shows up as a Warning in the logs instead of being
        // mistaken for a stale-viewport UX issue. The lookup is per-tab: the caller's tab id
        // must have a TabStamp recorded; the head sha there must match the active poller's
        // current head. Cross-tab poisoning is closed because a session-wide LastViewedHeadSha
        // no longer exists for one tab's mark-viewed to overwrite another tab's gate.
        if (!session.TabStamps.TryGetValue(tabId, out var callerStamp) || string.IsNullOrEmpty(callerStamp.HeadSha))
        {
            s_headShaNotStamped(loggerFactory.CreateLogger(LoggerCategory), sessionKey, null);
            return Results.Json(
                new SubmitErrorDto("head-sha-not-stamped",
                    "PR detail has not been marked viewed yet. Reload the PR and try again."),
                statusCode: StatusCodes.Status400BadRequest);
        }
        var pollSnapshot = activePrCache.GetCurrent(prRef);
        if (pollSnapshot is not null && !string.Equals(pollSnapshot.HeadSha, callerStamp.HeadSha, StringComparison.Ordinal))
        {
            s_headShaDrift(loggerFactory.CreateLogger(LoggerCategory), sessionKey, callerStamp.HeadSha, pollSnapshot.HeadSha, null);
            return Results.Json(new SubmitErrorDto("head-sha-drift", "Reload the PR before submitting."), statusCode: StatusCodes.Status400BadRequest);
        }

        // --- Per-PR submit lock. NOT `await using` — the lock must remain held for the duration of
        // the fire-and-forget pipeline; the Task.Run lambda's finally is the sole release site, so
        // ownership transfers there. CA2000 can't see the cross-task transfer; suppressed deliberately.
#pragma warning disable CA2000
        var handle = await lockRegistry.TryAcquireAsync(prRef, TimeSpan.Zero, ct).ConfigureAwait(false);
#pragma warning restore CA2000
        if (handle is null)
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A submit is already in flight for this PR."), statusCode: StatusCodes.Status409Conflict);

        var headSha = callerStamp.HeadSha;
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

        // Register a linked CTS so the discard endpoint can cancel this pipeline via
        // cancellationRegistry.RequestCancel(prRef). Also links ApplicationStopping so host
        // shutdown still cancels. NOT `await using` — ownership transfers to Task.Run's finally.
        // CA2000 is suppressed deliberately (same cross-task transfer pattern as handle above).
#pragma warning disable CA2000
        var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(appLifetime.ApplicationStopping);
        IDisposable registration;
        try
        {
            registration = cancellationRegistry.Register(prRef, linkedCts);
        }
        catch (InvalidOperationException)
        {
            linkedCts.Dispose();
            await handle.DisposeAsync().ConfigureAwait(false);
            return Results.Json(new SubmitErrorDto("submit-in-progress", "A prior submit's cleanup is still pending."), statusCode: StatusCodes.Status409Conflict);
        }
#pragma warning restore CA2000
        // pipelineCt is the linked token: cancelled by host shutdown OR by discard.
        var pipelineCt = linkedCts.Token;

        // Fire-and-forget. CRITICAL: pass CancellationToken.None to Task.Run and pipelineCt
        // (NOT the request `ct`) into the pipeline — the request `ct` is bound to
        // HttpContext.RequestAborted, which fires the moment the 200 response completes (or the
        // tab closes), which would silently kill the pipeline mid-run.
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
                        // PendingReviewId / ThreadId for the in-flight-recovery surface. Uses
                        // CancellationToken.None — the pipeline already returned (it caught the
                        // cancellation, if any); this cleanup write must land even during host shutdown.
                        await stateStore.UpdateAsync(state => state.WithSession(sessionKey, failed.NewSession), CancellationToken.None).ConfigureAwait(false);
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
                    case SubmitOutcome.Cancelled cancelled:
                        // Emit a terminal Failed SSE for the last-known step so the SubmitDialog
                        // progress UI moves out of an orphan "Started" state. The discard endpoint
                        // owns the user-facing "discarded" signal — we don't publish anything else here.
                        progress.Report(new SubmitProgressEvent(cancelled.LastStep, SubmitStepStatus.Failed, 0, 0, "cancelled"));
                        s_pipelineCancelled(loggerFactory.CreateLogger(LoggerCategory), sessionKey, cancelled.Reason, null);
                        break;
                }
            }
            catch (OperationCanceledException) when (pipelineCt.IsCancellationRequested)
            {
                // Host shutting down — per-step persists already wrote; the next session resumes via
                // the foreign-pending-review flow if a pending review exists on github.com. A
                // user-discard CTS is linked into pipelineCt (see DiscardOwnPendingReviewAsync), so
                // user-cancellation is caught first by the pipeline's own OCE catch →
                // SubmitOutcome.Cancelled; this host-shutdown catch only fires for genuine shutdown
                // races that bypass the pipeline's catch.
            }
#pragma warning disable CA1031 // a stray exception in a fire-and-forget background task must not crash the host
            catch (Exception ex)
            {
                // SubmitAsync's contract returns SubmitOutcome.Failed for step failures; reaching here
                // means a store crash / programming error. Log and swallow — re-throwing would only
                // surface an unobserved-task exception.
                s_pipelineThrew(loggerFactory.CreateLogger(LoggerCategory), sessionKey, ex);
            }
#pragma warning restore CA1031
            finally
            {
                // Unregister first so a fast resubmit can Register without collision.
                registration.Dispose();
                // Then dispose the CTS itself (frees the ApplicationStopping callback).
                linkedCts.Dispose();
                // Last: release the per-PR submit lock.
                await handle.DisposeAsync().ConfigureAwait(false);
            }
        }, CancellationToken.None);

        return Results.Json(new SubmitResponseDto("started"));
    }

    // ------------------------------------------------------------------ POST /submit/discard

    private static async Task<IResult> DiscardOwnPendingReviewAsync(
        string owner, string repo, int number,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        SubmitLockRegistry lockRegistry,
        SubmitCancellationRegistry cancellationRegistry,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();

        if (RequireSubscribed.Check(activePrCache, prRef) is { } notSubscribed)
            return notSubscribed;

        // Signal cancellation to any in-flight pipeline for this PR. Idempotent — no-op if nothing
        // is registered (either idle or already past registration). When a pipeline IS running,
        // its linked CTS fires, the pipeline's OCE catch returns SubmitOutcome.Cancelled, and
        // the Task.Run finally disposes registration + linkedCts before releasing the submit lock.
        cancellationRegistry.RequestCancel(prRef);

        // Wait for the pipeline (if any) to release the submit lock. We use a 30-second timeout
        // because a stuck pipeline could hold the lock beyond the typical OCE propagation time.
        // NOT `await using var` — TryAcquireAsync can return null on timeout (→ 504 below), and
        // binding a null result with `await using var` would NullReferenceException on the implicit
        // DisposeAsync call. The handle is disposed explicitly in the finally block, which only
        // executes on the non-null (successful-acquire) path.
        var discardHandle = await lockRegistry.TryAcquireAsync(prRef, DiscardTimeouts.LockAcquireTimeout, ct).ConfigureAwait(false);
        if (discardHandle is null)
            return Results.Json(new SubmitErrorDto("pipeline-cancellation-timeout",
                "The in-flight submit pipeline did not release within the allowed window. Try again."),
                statusCode: StatusCodes.Status504GatewayTimeout);

        try
        {
            // Re-fetch own pending review from GitHub (best-effort: if there is none, the stamps
            // clear is still correct). On network failure, surface a 502 so the user can retry.
            OwnPendingReviewSnapshot? snapshot;
            try
            {
                snapshot = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
            }
            catch (OperationCanceledException)
            {
                throw;
            }
            catch (HttpRequestException hre)
            {
                // Log the detailed hre (full message incl. any raw GitHub body) server-side BEFORE
                // returning the sanitized DTO — MapGithubError strips the detail from the client response.
                s_ownDiscardGitHubFailed(loggerFactory.CreateLogger(LoggerCategory), sessionKey, hre);
                return GitHubErrorMapper.ToResult(hre);
            }
#pragma warning disable CA1031  // catch-all so a rare GitHub SDK exception (non-HTTP) still surfaces a 502 instead of a bare 500
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                s_ownDiscardGitHubFailed(loggerFactory.CreateLogger(LoggerCategory), sessionKey, ex);
                return Results.Json(new SubmitErrorDto("github-network-error", "Network failure contacting GitHub."), statusCode: StatusCodes.Status502BadGateway);
            }
#pragma warning restore CA1031

            // If a pending review exists, delete it. 404 means it's already gone — treat as success.
            if (snapshot is not null)
            {
                try
                {
                    await submitter.DeletePendingReviewAsync(prRef, snapshot.PullRequestReviewId, ct).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (HttpRequestException hre) when (hre.StatusCode == System.Net.HttpStatusCode.NotFound)
                {
                    // Already gone — proceed to clear local stamps.
                }
                catch (HttpRequestException hre)
                {
                    // Non-404 GitHub error: surface as 502. Do NOT clear local stamps — the pending
                    // review still exists on GitHub, so a re-detect on the next submit would catch it.
                    // Log the detailed hre (full message incl. any raw GitHub body) server-side BEFORE
                    // returning the sanitized DTO — GitHubErrorMapper strips the detail from the client response.
                    s_ownDiscardGitHubFailed(loggerFactory.CreateLogger(LoggerCategory), sessionKey, hre);
                    return GitHubErrorMapper.ToResult(hre);
                }
#pragma warning disable CA1031  // catch-all so a rare GitHub SDK exception (non-HTTP) still surfaces a 502 instead of a bare 500
                catch (Exception ex) when (ex is not OperationCanceledException)
                {
                    s_ownDiscardGitHubFailed(loggerFactory.CreateLogger(LoggerCategory), sessionKey, ex);
                    return Results.Json(new SubmitErrorDto("github-network-error", "Network failure contacting GitHub."), statusCode: StatusCodes.Status502BadGateway);
                }
#pragma warning restore CA1031
            }

            // Clear the session's pending-review stamps (PendingReviewId / ThreadId / ReplyCommentId).
            await stateStore.UpdateAsync(
                s => SessionOverlays.ClearPendingReviewStamps(s, sessionKey), ct).ConfigureAwait(false);

            bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));

            return Results.NoContent();
        }
        finally
        {
            await discardHandle.DisposeAsync().ConfigureAwait(false);
        }
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
        if (RequireSubscribed.Check(activePrCache, prRef) is { } notSubscribed)
            return notSubscribed;
        if (string.IsNullOrEmpty(request?.PullRequestReviewId))
            return Results.Json(new SubmitErrorDto("pull-request-review-id-missing", "pullRequestReviewId is required."), statusCode: StatusCodes.Status400BadRequest);

        // TOCTOU defense — re-fetch Snapshot B; reject if the pending review changed during the prompt.
        var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
        if (snapshotB is null || !string.Equals(snapshotB.PullRequestReviewId, request.PullRequestReviewId, StringComparison.Ordinal))
            return Results.Json(new SubmitErrorDto("pending-review-state-changed", "The pending review changed during the prompt. Please retry submit."), statusCode: StatusCodes.Status409Conflict);

        // Import each thread as a DraftComment (Status=Draft, ThreadId stamped); reply chains as
        // DraftReply (ReplyCommentId stamped). Bodies have all PRism marker prefixes stripped (R8) —
        // computed once and reused for both the persisted drafts and the 200-response payload.
        // OriginalLineContent is enriched from the file content at OriginalCommitOid (R7) — an empty
        // anchor poisons reconciliation, so a fetch failure imports the draft Stale instead.
        var imported = new List<ImportedThread>(snapshotB.Threads.Count);
        foreach (var t in snapshotB.Threads)
        {
            var (anchoredLine, status) = await EnrichAnchoredLineAsync(prReader, prRef, t, ct).ConfigureAwait(false);
            imported.Add(new ImportedThread(
                t,
                StrippedBody: StripBody(t.BodyMarkdown),
                AnchoredLine: anchoredLine,
                Status: status,
                Replies: t.Comments.Select(c => new ImportedReply(c, StripBody(c.BodyMarkdown))).ToList()));
        }

        var newDrafts = imported.Select(it => new DraftComment(
            Id: Guid.NewGuid().ToString(),
            FilePath: it.Thread.FilePath,
            LineNumber: it.Thread.LineNumber,
            Side: it.Thread.Side,
            AnchoredSha: it.Thread.OriginalCommitOid,
            AnchoredLineContent: it.AnchoredLine,
            BodyMarkdown: it.StrippedBody,
            Status: it.Status,
            IsOverriddenStale: false,
            ThreadId: it.Thread.PullRequestReviewThreadId)).ToList();
        var newReplies = imported.SelectMany(it => it.Replies.Select(r => new DraftReply(
            Id: Guid.NewGuid().ToString(),
            ParentThreadId: it.Thread.PullRequestReviewThreadId,
            ReplyCommentId: r.Comment.CommentId,
            BodyMarkdown: r.StrippedBody,
            Status: DraftStatus.Draft,
            IsOverriddenStale: false))).ToList();

        await stateStore.UpdateAsync(state =>
        {
            var existing = state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? s : PrDraftEndpoints.NewEmptySession();
            var merged = existing with
            {
                DraftComments = existing.DraftComments.Concat(newDrafts).ToList(),
                DraftReplies = existing.DraftReplies.Concat(newReplies).ToList(),
                PendingReviewId = snapshotB.PullRequestReviewId,
                PendingReviewCommitOid = snapshotB.CommitOid,
            };
            return state.WithSession(sessionKey, merged);
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
            threads = imported.Select(it => new
            {
                id = it.Thread.PullRequestReviewThreadId,
                filePath = it.Thread.FilePath,
                lineNumber = it.Thread.LineNumber,
                side = it.Thread.Side,
                isResolved = it.Thread.IsResolved,
                body = it.StrippedBody,
                replies = it.Replies.Select(r => new { id = r.Comment.CommentId, body = r.StrippedBody }).ToList(),
            }).ToList(),
        });
    }

    private static string StripBody(string body) => PipelineMarker.StripAllMarkerPrefixes(PipelineMarker.StripIfPresent(body));

    private sealed record ImportedThread(
        PendingReviewThreadSnapshot Thread, string StrippedBody, string AnchoredLine, DraftStatus Status, List<ImportedReply> Replies);

    private sealed record ImportedReply(PendingReviewCommentSnapshot Comment, string StrippedBody);

    // ----------------------------------------- POST /submit/foreign-pending-review/discard

    private static async Task<IResult> DiscardForeignPendingReviewAsync(
        string owner, string repo, int number,
        ForeignPendingReviewActionDto? request,
        IAppStateStore stateStore,
        IActivePrCache activePrCache,
        IReviewSubmitter submitter,
        IReviewEventBus bus,
        ILoggerFactory loggerFactory,
        CancellationToken ct)
    {
        var prRef = new PrReference(owner, repo, number);
        var sessionKey = prRef.ToString();
        if (RequireSubscribed.Check(activePrCache, prRef) is { } notSubscribed)
            return notSubscribed;
        if (string.IsNullOrEmpty(request?.PullRequestReviewId))
            return Results.Json(new SubmitErrorDto("pull-request-review-id-missing", "pullRequestReviewId is required."), statusCode: StatusCodes.Status400BadRequest);

        var snapshotB = await submitter.FindOwnPendingReviewAsync(prRef, ct).ConfigureAwait(false);
        if (snapshotB is null || !string.Equals(snapshotB.PullRequestReviewId, request.PullRequestReviewId, StringComparison.Ordinal))
            return Results.Json(new SubmitErrorDto("pending-review-state-changed", "The pending review changed during the prompt. Please retry submit."), statusCode: StatusCodes.Status409Conflict);

        // Unlike the closed/merged bulk-discard's *courtesy* delete (best-effort, never blocks),
        // this is the user's explicit "delete the pending review on GitHub" intent — a failure must
        // surface so they can retry. Don't clear local state on failure: GitHub still has the pending
        // review, so a re-detect on the next submit would re-prompt — clearing now would lose track.
        try
        {
            await submitter.DeletePendingReviewAsync(prRef, snapshotB.PullRequestReviewId, ct).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
#pragma warning disable CA1031 // surface any GitHub/transport failure as a structured error rather than a bare 500
        catch (Exception ex)
        {
            s_foreignDiscardDeleteFailed(loggerFactory.CreateLogger(LoggerCategory), sessionKey, ex);
            return Results.Json(new SubmitErrorDto("delete-failed", "Failed to delete the pending review on GitHub. Please retry."), statusCode: StatusCodes.Status502BadGateway);
        }
#pragma warning restore CA1031

        await stateStore.UpdateAsync(state =>
        {
            if (!state.Reviews.Sessions.TryGetValue(sessionKey, out var existing)) return state;
            return state.WithSession(sessionKey, existing with { PendingReviewId = null, PendingReviewCommitOid = null });
        }, ct).ConfigureAwait(false);

        bus.Publish(new StateChanged(prRef, PendingReviewFields, SourceTabId: null));
        return Results.Ok();
    }

    // ------------------------------------------------------------------ helpers

    // Canonical kebab-case verdict parse — the single wire form (#318). Exact-string match:
    // legacy PascalCase/camelCase ("RequestChanges"/"requestChanges"), numeric-ordinal tokens
    // (the string "1"), and null all reject. The shared JsonStringEnumConverter is deliberately
    // NOT used here — it matches enum names case-insensitively AND (with allowIntegerValues, the
    // default) accepts both the JSON number 1 and the string token "1" as ordinal 1 (verified on
    // net10.0), so it cannot enforce the exact-kebab cutover this endpoint's contract promises.
    private static bool TryParseVerdict(string? s, out SubmitEvent verdict)
    {
        verdict = s switch
        {
            "approve" => SubmitEvent.Approve,
            "request-changes" => SubmitEvent.RequestChanges,
            "comment" => SubmitEvent.Comment,
            _ => default,
        };
        return s is "approve" or "request-changes" or "comment";
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
        // Strip a trailing CR so the anchored line matches the reconciliation pipeline's
        // normalisation (LineMatching.SplitLines TrimEnd('\r')); otherwise a CRLF-ending file's
        // imported draft would never exact-match and would land Stale / mis-anchor on the next Reload.
        return (lines[t.LineNumber - 1].TrimEnd('\r'), DraftStatus.Draft);
    }

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
