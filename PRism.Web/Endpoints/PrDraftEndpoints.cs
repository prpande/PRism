using System.Text.RegularExpressions;
using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.PrDetail;
using PRism.Core.State;

namespace PRism.Web.Endpoints;

internal static class PrDraftEndpoints
{
    private static readonly Regex Sha40 = new("^[0-9a-f]{40}$", RegexOptions.Compiled);
    private static readonly Regex Sha64 = new("^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly Regex ParentThreadId = new("^PRRT_[A-Za-z0-9_-]{1,128}$", RegexOptions.Compiled);
    private const int BodyMarkdownMaxChars = 8192;

    // Pre-allocated FieldsTouched arrays per spec § 4.3 — one per touchable field name.
    // PatchOutcome.Applied references these instead of allocating new[] per request.
    private static readonly string[] FieldsTouchedDraftVerdict = { "draft-verdict" };
    private static readonly string[] FieldsTouchedDraftSummary = { "draft-summary" };
    private static readonly string[] FieldsTouchedDraftComments = { "draft-comments" };
    private static readonly string[] FieldsTouchedDraftReplies = { "draft-replies" };
    private static readonly string[] FieldsTouchedDraftVerdictStatus = { "draft-verdict-status" };
    private static readonly string[] FieldsTouchedLastSeenCommentId = { "last-seen-comment-id" };

    public static IEndpointRouteBuilder MapPrDraftEndpoints(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapGet("/api/pr/{owner}/{repo}/{number:int}/draft", GetDraft);
        app.MapPut("/api/pr/{owner}/{repo}/{number:int}/draft", PutDraft);
        return app;
    }

    private static async Task<IResult> GetDraft(
        string owner, string repo, int number,
        IAppStateStore store, CancellationToken ct)
    {
        var refKey = $"{owner}/{repo}/{number}";
        var state = await store.LoadAsync(ct).ConfigureAwait(false);
        if (!state.Reviews.Sessions.TryGetValue(refKey, out var session))
            return Results.Ok(EmptyReviewSessionDto());
        return Results.Ok(MapToDto(session));
    }

    private static async Task<IResult> PutDraft(
        string owner, string repo, int number,
        ReviewSessionPatch? patch,
        HttpContext httpContext,
        IAppStateStore store,
        IActivePrCache cache,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(httpContext);
        if (patch is null)
            return Results.BadRequest(new { error = "patch-body-missing" });

        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();

        var setFields = EnumerateSetFields(patch).ToList();
        if (setFields.Count != 1)
            return Results.BadRequest(new { error = "exactly one patch field must be set", fieldsSet = setFields });

        var validation = ValidatePatch(patch);
        if (validation is not null) return validation;

        var kind = setFields[0];
        PatchOutcome outcome = new PatchOutcome.NoOp();

        await store.UpdateAsync(state =>
        {
            var session = state.Reviews.Sessions.TryGetValue(refKey, out var existing)
                ? existing
                : new ReviewSessionState(
                    LastViewedHeadSha: null, LastSeenCommentId: null,
                    PendingReviewId: null, PendingReviewCommitOid: null,
                    ViewedFiles: new Dictionary<string, string>(),
                    DraftComments: Array.Empty<DraftComment>(),
                    DraftReplies: Array.Empty<DraftReply>(),
                    DraftSummaryMarkdown: null, DraftVerdict: null,
                    DraftVerdictStatus: DraftVerdictStatus.Draft);

            outcome = ApplyPatch(kind, patch, session, cache, prRef);

            if (outcome is PatchOutcome.Applied applied)
            {
                var sessions = new Dictionary<string, ReviewSessionState>(state.Reviews.Sessions)
                {
                    [refKey] = applied.Updated
                };
                return state with { Reviews = state.Reviews with { Sessions = sessions } };
            }
            return state;
        }, ct).ConfigureAwait(false);

        // Publish events outside _gate per spec § 4.4. NoOp/error outcomes intentionally
        // do not publish (prevents the false-StateChanged-on-no-op bug from the Step 3
        // sketch — markAllRead on cold cache, confirmVerdict-when-already-draft, missing
        // draft id, etc.).
        if (outcome is PatchOutcome.Applied a)
        {
            if (a.PublishSaved && a.EventDraftId is not null)
                bus.Publish(new DraftSaved(prRef, a.EventDraftId, sourceTabId));
            if (a.PublishDiscarded && a.EventDraftId is not null)
                bus.Publish(new DraftDiscarded(prRef, a.EventDraftId, sourceTabId));
            bus.Publish(new StateChanged(prRef, a.FieldsTouched, sourceTabId));
        }

        return outcome switch
        {
            PatchOutcome.Applied applied when applied.AssignedId is not null
                => Results.Ok(new AssignedIdResponse(applied.AssignedId)),
            PatchOutcome.Applied => Results.Ok(),
            PatchOutcome.NoOp => Results.Ok(),
            PatchOutcome.DraftNotFound => Results.NotFound(new { error = "draft-not-found" }),
            PatchOutcome.NotStale => Results.BadRequest(new { error = "not-stale" }),
            PatchOutcome.FileNotInDiff => Results.UnprocessableEntity(new { error = "draft-file-not-in-diff" }),
            PatchOutcome.NotSubscribed => Results.NotFound(new { error = "not-subscribed" }),
            _ => Results.StatusCode(StatusCodes.Status500InternalServerError)
        };
    }

    internal abstract record PatchOutcome
    {
        internal sealed record Applied(
            ReviewSessionState Updated,
            string? AssignedId,
            string? EventDraftId,
            bool PublishSaved,
            bool PublishDiscarded,
            IReadOnlyList<string> FieldsTouched) : PatchOutcome;

        internal sealed record DraftNotFound : PatchOutcome;
        internal sealed record NotStale : PatchOutcome;
        internal sealed record FileNotInDiff : PatchOutcome;
        internal sealed record NotSubscribed : PatchOutcome;
        internal sealed record NoOp : PatchOutcome;
    }

    private static PatchOutcome ApplyPatch(
        string kind,
        ReviewSessionPatch patch,
        ReviewSessionState session,
        IActivePrCache cache,
        PrReference prRef)
    {
        switch (kind)
        {
            case "draftVerdict":
                {
                    var verdict = patch.DraftVerdict switch
                    {
                        "approve" => (DraftVerdict?)DraftVerdict.Approve,
                        "requestChanges" => (DraftVerdict?)DraftVerdict.RequestChanges,
                        "comment" => (DraftVerdict?)DraftVerdict.Comment,
                        null => null,
                        _ => throw new ArgumentException($"unknown verdict: {patch.DraftVerdict}")
                    };
                    return new PatchOutcome.Applied(
                        session with { DraftVerdict = verdict },
                        AssignedId: null, EventDraftId: null,
                        PublishSaved: false, PublishDiscarded: false,
                        FieldsTouched: FieldsTouchedDraftVerdict);
                }

            case "draftSummaryMarkdown":
                return new PatchOutcome.Applied(
                    session with { DraftSummaryMarkdown = patch.DraftSummaryMarkdown },
                    null, null, false, false, FieldsTouchedDraftSummary);

            case "newDraftComment":
                {
                    var n = patch.NewDraftComment!;
                    var id = Guid.NewGuid().ToString();
                    var draft = new DraftComment(
                        Id: id,
                        FilePath: n.FilePath, LineNumber: n.LineNumber, Side: n.Side,
                        AnchoredSha: n.AnchoredSha, AnchoredLineContent: n.AnchoredLineContent,
                        BodyMarkdown: n.BodyMarkdown,
                        Status: DraftStatus.Draft, IsOverriddenStale: false);
                    var list = new List<DraftComment>(session.DraftComments) { draft };
                    return new PatchOutcome.Applied(
                        session with { DraftComments = list },
                        AssignedId: id, EventDraftId: id,
                        PublishSaved: true, PublishDiscarded: false,
                        FieldsTouched: FieldsTouchedDraftComments);
                }

            case "newPrRootDraftComment":
                {
                    var n = patch.NewPrRootDraftComment!;
                    var id = Guid.NewGuid().ToString();
                    var draft = new DraftComment(
                        Id: id,
                        FilePath: null, LineNumber: null, Side: "pr",
                        AnchoredSha: null, AnchoredLineContent: null,
                        BodyMarkdown: n.BodyMarkdown,
                        Status: DraftStatus.Draft, IsOverriddenStale: false);
                    var list = new List<DraftComment>(session.DraftComments) { draft };
                    return new PatchOutcome.Applied(
                        session with { DraftComments = list },
                        id, id, true, false, FieldsTouchedDraftComments);
                }

            case "updateDraftComment":
                {
                    var u = patch.UpdateDraftComment!;
                    var list = session.DraftComments.ToList();
                    var idx = list.FindIndex(d => d.Id == u.Id);
                    if (idx < 0) return new PatchOutcome.DraftNotFound();
                    list[idx] = list[idx] with { BodyMarkdown = u.BodyMarkdown };
                    return new PatchOutcome.Applied(
                        session with { DraftComments = list },
                        null, u.Id, true, false, FieldsTouchedDraftComments);
                }

            case "deleteDraftComment":
                {
                    var d = patch.DeleteDraftComment!;
                    var list = session.DraftComments.ToList();
                    var idx = list.FindIndex(x => x.Id == d.Id);
                    if (idx < 0) return new PatchOutcome.DraftNotFound();
                    list.RemoveAt(idx);
                    return new PatchOutcome.Applied(
                        session with { DraftComments = list },
                        null, d.Id, false, true, FieldsTouchedDraftComments);
                }

            case "newDraftReply":
                {
                    var n = patch.NewDraftReply!;
                    var id = Guid.NewGuid().ToString();
                    var reply = new DraftReply(
                        Id: id, ParentThreadId: n.ParentThreadId, ReplyCommentId: null,
                        BodyMarkdown: n.BodyMarkdown, Status: DraftStatus.Draft, IsOverriddenStale: false);
                    var list = new List<DraftReply>(session.DraftReplies) { reply };
                    return new PatchOutcome.Applied(
                        session with { DraftReplies = list },
                        id, id, true, false, FieldsTouchedDraftReplies);
                }

            case "updateDraftReply":
                {
                    var u = patch.UpdateDraftReply!;
                    var list = session.DraftReplies.ToList();
                    var idx = list.FindIndex(r => r.Id == u.Id);
                    if (idx < 0) return new PatchOutcome.DraftNotFound();
                    list[idx] = list[idx] with { BodyMarkdown = u.BodyMarkdown };
                    return new PatchOutcome.Applied(
                        session with { DraftReplies = list },
                        null, u.Id, true, false, FieldsTouchedDraftReplies);
                }

            case "deleteDraftReply":
                {
                    var d = patch.DeleteDraftReply!;
                    var list = session.DraftReplies.ToList();
                    var idx = list.FindIndex(r => r.Id == d.Id);
                    if (idx < 0) return new PatchOutcome.DraftNotFound();
                    list.RemoveAt(idx);
                    return new PatchOutcome.Applied(
                        session with { DraftReplies = list },
                        null, d.Id, false, true, FieldsTouchedDraftReplies);
                }

            case "confirmVerdict":
                if (session.DraftVerdictStatus == DraftVerdictStatus.Draft)
                    return new PatchOutcome.NoOp();
                return new PatchOutcome.Applied(
                    session with { DraftVerdictStatus = DraftVerdictStatus.Draft },
                    null, null, false, false, FieldsTouchedDraftVerdictStatus);

            case "markAllRead":
                {
                    // SECURITY: closes the drive-by-tab vector per spec § 4.7. Only an SSE
                    // subscriber for this PR can mark-all-read on it.
                    if (!cache.IsSubscribed(prRef))
                        return new PatchOutcome.NotSubscribed();
                    var snap = cache.GetCurrent(prRef);
                    if (snap is null || snap.HighestIssueCommentId is null)
                        return new PatchOutcome.NoOp();
                    var newId = snap.HighestIssueCommentId.Value.ToString(System.Globalization.CultureInfo.InvariantCulture);
                    if (session.LastSeenCommentId == newId)
                        return new PatchOutcome.NoOp();
                    return new PatchOutcome.Applied(
                        session with { LastSeenCommentId = newId },
                        null, null, false, false, FieldsTouchedLastSeenCommentId);
                }

            case "overrideStale":
                {
                    var os = patch.OverrideStale!;
                    var commentList = session.DraftComments.ToList();
                    var commentIdx = commentList.FindIndex(d => d.Id == os.Id);
                    if (commentIdx >= 0)
                    {
                        if (commentList[commentIdx].Status != DraftStatus.Stale)
                            return new PatchOutcome.NotStale();
                        commentList[commentIdx] = commentList[commentIdx] with { IsOverriddenStale = true, Status = DraftStatus.Draft };
                        return new PatchOutcome.Applied(
                            session with { DraftComments = commentList },
                            null, os.Id, true, false, FieldsTouchedDraftComments);
                    }
                    var replyList = session.DraftReplies.ToList();
                    var replyIdx = replyList.FindIndex(r => r.Id == os.Id);
                    if (replyIdx >= 0)
                    {
                        if (replyList[replyIdx].Status != DraftStatus.Stale)
                            return new PatchOutcome.NotStale();
                        replyList[replyIdx] = replyList[replyIdx] with { IsOverriddenStale = true, Status = DraftStatus.Draft };
                        return new PatchOutcome.Applied(
                            session with { DraftReplies = replyList },
                            null, os.Id, true, false, FieldsTouchedDraftReplies);
                    }
                    return new PatchOutcome.DraftNotFound();
                }

            default:
                throw new InvalidOperationException($"unhandled patch kind: {kind}");
        }
    }

    private static IEnumerable<string> EnumerateSetFields(ReviewSessionPatch p)
    {
        if (p.DraftVerdict is not null) yield return "draftVerdict";
        if (p.DraftSummaryMarkdown is not null) yield return "draftSummaryMarkdown";
        if (p.NewDraftComment is not null) yield return "newDraftComment";
        if (p.NewPrRootDraftComment is not null) yield return "newPrRootDraftComment";
        if (p.UpdateDraftComment is not null) yield return "updateDraftComment";
        if (p.DeleteDraftComment is not null) yield return "deleteDraftComment";
        if (p.NewDraftReply is not null) yield return "newDraftReply";
        if (p.UpdateDraftReply is not null) yield return "updateDraftReply";
        if (p.DeleteDraftReply is not null) yield return "deleteDraftReply";
        if (p.ConfirmVerdict == true) yield return "confirmVerdict";
        if (p.MarkAllRead == true) yield return "markAllRead";
        if (p.OverrideStale is not null) yield return "overrideStale";
    }

    private static IResult? ValidatePatch(ReviewSessionPatch patch)
    {
        if (patch.NewDraftComment is { } ndc)
        {
            if (ndc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                return Results.UnprocessableEntity(new { error = "body-too-large" });
            if (string.IsNullOrWhiteSpace(ndc.BodyMarkdown))
                return Results.BadRequest(new { error = "body-empty" });
            if (!Sha40.IsMatch(ndc.AnchoredSha) && !Sha64.IsMatch(ndc.AnchoredSha))
                return Results.UnprocessableEntity(new { error = "sha-format-invalid" });
            if (!IsCanonicalFilePath(ndc.FilePath))
                return Results.UnprocessableEntity(new { error = "file-path-invalid" });
        }
        if (patch.NewPrRootDraftComment is { } nprdc)
        {
            if (nprdc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                return Results.UnprocessableEntity(new { error = "body-too-large" });
            if (string.IsNullOrWhiteSpace(nprdc.BodyMarkdown))
                return Results.BadRequest(new { error = "body-empty" });
        }
        if (patch.NewDraftReply is { } ndr)
        {
            if (ndr.BodyMarkdown.Length > BodyMarkdownMaxChars)
                return Results.UnprocessableEntity(new { error = "body-too-large" });
            if (string.IsNullOrWhiteSpace(ndr.BodyMarkdown))
                return Results.BadRequest(new { error = "body-empty" });
            if (!ParentThreadId.IsMatch(ndr.ParentThreadId))
                return Results.UnprocessableEntity(new { error = "thread-id-format-invalid" });
        }
        if (patch.UpdateDraftComment is { } udc && udc.BodyMarkdown.Length > BodyMarkdownMaxChars)
            return Results.UnprocessableEntity(new { error = "body-too-large" });
        if (patch.UpdateDraftReply is { } udr && udr.BodyMarkdown.Length > BodyMarkdownMaxChars)
            return Results.UnprocessableEntity(new { error = "body-too-large" });
        if (patch.DraftSummaryMarkdown is { } summary && summary.Length > BodyMarkdownMaxChars)
            return Results.UnprocessableEntity(new { error = "body-too-large" });
        return null;
    }

    private static bool IsCanonicalFilePath(string path)
    {
        if (string.IsNullOrEmpty(path)) return false;
        if (path.Length > 4096) return false;
        if (path.Contains('\\', StringComparison.Ordinal) || path.Contains('\0', StringComparison.Ordinal)) return false;
        if (path.StartsWith('/') || path.EndsWith('/')) return false;
        if (path.Contains("/../", StringComparison.Ordinal) || path.StartsWith("../", StringComparison.Ordinal) || path.EndsWith("/..", StringComparison.Ordinal)) return false;
        if (path.Contains("/./", StringComparison.Ordinal) || path.StartsWith("./", StringComparison.Ordinal) || path.EndsWith("/.", StringComparison.Ordinal)) return false;
        foreach (var c in path)
            if (c < 0x20 || (c >= 0x7F && c < 0xA0)) return false;
        if (path != path.Normalize(System.Text.NormalizationForm.FormC)) return false;
        return true;
    }

    // Shared with PrReloadEndpoints (Task 29) — keep `internal` visibility.
    internal static ReviewSessionDto MapToDto(ReviewSessionState s) => new(
        DraftVerdict: s.DraftVerdict,
        DraftVerdictStatus: s.DraftVerdictStatus,
        DraftSummaryMarkdown: s.DraftSummaryMarkdown,
        DraftComments: s.DraftComments.Select(MapDraft).ToList(),
        DraftReplies: s.DraftReplies.Select(MapReply).ToList(),
        IterationOverrides: Array.Empty<IterationOverrideDto>(),
        PendingReviewId: s.PendingReviewId,
        PendingReviewCommitOid: s.PendingReviewCommitOid,
        FileViewState: new FileViewStateDto(s.ViewedFiles));

    private static DraftCommentDto MapDraft(DraftComment d) => new(
        d.Id, d.FilePath, d.LineNumber, d.Side, d.AnchoredSha, d.AnchoredLineContent,
        d.BodyMarkdown, d.Status, d.IsOverriddenStale);

    private static DraftReplyDto MapReply(DraftReply r) => new(
        r.Id, r.ParentThreadId, r.ReplyCommentId, r.BodyMarkdown,
        r.Status, r.IsOverriddenStale);

    private static ReviewSessionDto EmptyReviewSessionDto() => new(
        null, DraftVerdictStatus.Draft, null,
        Array.Empty<DraftCommentDto>(), Array.Empty<DraftReplyDto>(),
        Array.Empty<IterationOverrideDto>(),
        null, null,
        new FileViewStateDto(new Dictionary<string, string>()));
}
