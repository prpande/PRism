using System.Text.Json;
using System.Text.RegularExpressions;

using PRism.Core.Contracts;
using PRism.Core.Events;
using PRism.Core.Json;
using PRism.Core.PrDetail;
using PRism.Core.State;
using PRism.Core.Submit.Pipeline;

namespace PRism.Web.Endpoints;

internal static class PrDraftEndpoints
{
    private static readonly Regex Sha40 = new("^[0-9a-f]{40}$", RegexOptions.Compiled);
    private static readonly Regex Sha64 = new("^[0-9a-f]{64}$", RegexOptions.Compiled);
    private static readonly Regex ParentThreadId = new("^PRRT_[A-Za-z0-9_-]{1,128}$", RegexOptions.Compiled);
    private const int BodyMarkdownMaxChars = 8192;

    private static readonly JsonSerializerOptions Api = JsonSerializerOptionsFactory.Api;

    // Pre-allocated FieldsTouched arrays per spec § 4.3 — one per touchable field name.
    private static readonly string[] FieldsTouchedDraftVerdict = { "draft-verdict" };
    private static readonly string[] FieldsTouchedDraftSummary = { "draft-summary" };
    private static readonly string[] FieldsTouchedDraftComments = { "draft-comments" };
    private static readonly string[] FieldsTouchedDraftReplies = { "draft-replies" };
    private static readonly string[] FieldsTouchedDraftVerdictStatus = { "draft-verdict-status" };
    private static readonly string[] FieldsTouchedLastSeenCommentId = { "last-seen-comment-id" };

    // Object-valued patch kinds (operand is a JSON object).
    private static readonly string[] ObjectKinds =
    {
        "newDraftComment", "newPrRootDraftComment", "updateDraftComment", "deleteDraftComment",
        "newDraftReply", "updateDraftReply", "deleteDraftReply", "overrideStale",
    };
    // Boolean-valued patch kinds (operand must be `true` to count as set — matches the historic
    // EnumerateSetFields semantics where `false` meant "not set"; the frontend always emits `true`).
    private static readonly string[] BoolKinds = { "confirmVerdict", "markAllRead" };
    // String-or-null kinds — present-with-string sets the value, present-with-null clears it,
    // absent leaves it unchanged. This is the JsonElement wire-shape's whole point (spec § 10):
    // the historic typed-record binding couldn't distinguish present-null from absent.
    private static readonly string[] ScalarKinds = { "draftVerdict", "draftSummaryMarkdown" };

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

    // PUT /api/pr/{ref}/draft — JsonElement-based parsing so present-null distinguishes from absent
    // (spec § 10 / S4 deferral 5 option (b)). Wire contract: exactly one operation per request; the
    // property whose name matches a known patch kind is the operation, its value (including explicit
    // null on draftVerdict / draftSummaryMarkdown) is the operand. A property whose value is null on
    // a non-clearable kind, or `false` on a bool kind, is treated as "not set" — so a typed-record
    // serialization that emits every field (`{"draftVerdict":null, "newDraftComment":{...}, …}`)
    // still resolves to the single non-null operation, exactly as the historic binding did.
    private static async Task<IResult> PutDraft(
        string owner, string repo, int number,
        HttpContext httpContext,
        IAppStateStore store,
        IActivePrCache cache,
        IReviewEventBus bus,
        CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(httpContext);

        var prRef = new PrReference(owner, repo, number);
        var refKey = prRef.ToString();
        var sourceTabId = httpContext.Request.Headers["X-PRism-Tab-Id"].FirstOrDefault();

        JsonDocument doc;
        try
        {
            doc = await JsonDocument.ParseAsync(httpContext.Request.Body, default, ct).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            return Results.BadRequest(new { error = "patch-body-missing" });
        }

        using (doc)
        {
            if (doc.RootElement.ValueKind != JsonValueKind.Object)
                return Results.BadRequest(new { error = "patch-body-missing" });

            // Resolve the single operation. "Real" ops: an object kind with an object value, a bool
            // kind with `true`, or a scalar kind with a non-null string. "Clear" ops: a scalar kind
            // with explicit null. If there is exactly one real op, it wins and any clear-null on the
            // other scalar kind is ignored (the spurious-nulls case). Otherwise a lone clear op wins.
            (string Kind, JsonElement Value)? realOp = null;
            var realCount = 0;
            (string Kind, JsonElement Value)? clearOp = null;
            var clearCount = 0;

            foreach (var prop in doc.RootElement.EnumerateObject())
            {
                var v = prop.Value;
                if (Array.IndexOf(ObjectKinds, prop.Name) >= 0)
                {
                    if (v.ValueKind == JsonValueKind.Object) { realOp = (prop.Name, v); realCount++; }
                }
                else if (Array.IndexOf(BoolKinds, prop.Name) >= 0)
                {
                    if (v.ValueKind == JsonValueKind.True) { realOp = (prop.Name, v); realCount++; }
                }
                else if (Array.IndexOf(ScalarKinds, prop.Name) >= 0)
                {
                    if (v.ValueKind == JsonValueKind.Null) { clearOp = (prop.Name, v); clearCount++; }
                    else { realOp = (prop.Name, v); realCount++; }
                }
                // Unknown property names are ignored (parity with the historic record binding).
            }

            (string Kind, JsonElement Value) op;
            if (realCount == 1) op = realOp!.Value;
            else if (realCount == 0 && clearCount == 1) op = clearOp!.Value;
            else return Results.BadRequest(new { error = "exactly one patch field must be set", realCount, clearCount });

            // Marker-prefix collision defense (spec § 4 / Task 40): reject user bodies that contain
            // the literal `<!-- prism:client-id:` substring outside fenced code blocks — such a body
            // would confuse the SubmitPipeline's lost-response adoption matcher.
            var userBody = ExtractUserBody(op.Kind, op.Value);
            if (userBody is not null && PipelineMarker.ContainsMarkerPrefix(userBody))
                return Results.Json(new
                {
                    code = "marker-prefix-collision",
                    message = "Comment body cannot contain the internal marker string '<!-- prism:client-id:'",
                }, statusCode: StatusCodes.Status400BadRequest);

            var validation = ValidatePatch(op.Kind, op.Value);
            if (validation is not null) return validation;

            PatchOutcome outcome = new PatchOutcome.NoOp();
            await store.UpdateAsync(state =>
            {
                var session = state.Reviews.Sessions.TryGetValue(refKey, out var existing)
                    ? existing
                    : NewEmptySession();

                outcome = ApplyPatch(op.Kind, op.Value, session, cache, prRef);

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

            // Publish events outside _gate per spec § 4.4. NoOp / error outcomes intentionally do
            // not publish (prevents false-StateChanged-on-no-op).
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
                PatchOutcome.PatchShapeInvalid => Results.BadRequest(new { error = "patch-shape-invalid" }),
                _ => Results.StatusCode(StatusCodes.Status500InternalServerError)
            };
        }
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
        internal sealed record PatchShapeInvalid : PatchOutcome;
        internal sealed record NoOp : PatchOutcome;
    }

    private static PatchOutcome ApplyPatch(
        string kind,
        JsonElement value,
        ReviewSessionState session,
        IActivePrCache cache,
        PrReference prRef)
    {
        switch (kind)
        {
            case "draftVerdict":
                {
                    DraftVerdict? verdict = value.ValueKind == JsonValueKind.Null
                        ? null
                        : value.GetString() switch
                        {
                            "approve" => DraftVerdict.Approve,
                            "requestChanges" => DraftVerdict.RequestChanges,
                            "comment" => DraftVerdict.Comment,
                            _ => throw new InvalidOperationException("verdict already validated"),
                        };
                    return new PatchOutcome.Applied(
                        session with { DraftVerdict = verdict },
                        AssignedId: null, EventDraftId: null,
                        PublishSaved: false, PublishDiscarded: false,
                        FieldsTouched: FieldsTouchedDraftVerdict);
                }

            case "draftSummaryMarkdown":
                {
                    var summary = value.ValueKind == JsonValueKind.Null ? null : value.GetString();
                    return new PatchOutcome.Applied(
                        session with { DraftSummaryMarkdown = summary },
                        null, null, false, false, FieldsTouchedDraftSummary);
                }

            case "newDraftComment":
                {
                    if (!TryDeserialize<NewDraftCommentPayload>(value, out var n)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<NewPrRootDraftCommentPayload>(value, out var n)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<UpdateDraftCommentPayload>(value, out var u)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<DeleteDraftPayload>(value, out var d)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<NewDraftReplyPayload>(value, out var n)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<UpdateDraftPayload>(value, out var u)) return new PatchOutcome.PatchShapeInvalid();
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
                    if (!TryDeserialize<DeleteDraftPayload>(value, out var d)) return new PatchOutcome.PatchShapeInvalid();
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
                    // SECURITY (PoC scope): IsSubscribed checks whether ANY tab is currently
                    // subscribed to this PR (registry presence), not whether the caller's session
                    // owns a subscription. Closed by OriginCheckMiddleware + SameSite=Strict +
                    // session token + the single-user PoC threat model — see deferrals "PR3:
                    // markAllRead authorization broader than spec § 4.7".
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
                    if (!TryDeserialize<OverrideStalePayload>(value, out var os)) return new PatchOutcome.PatchShapeInvalid();
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

    // Pulls the user-authored body text out of a patch operand, for the marker-prefix collision
    // check. Returns null for operations that carry no free-text body.
    private static string? ExtractUserBody(string kind, JsonElement value)
    {
        switch (kind)
        {
            case "draftSummaryMarkdown":
                return value.ValueKind == JsonValueKind.String ? value.GetString() : null;
            case "newDraftComment":
            case "newPrRootDraftComment":
            case "updateDraftComment":
            case "newDraftReply":
            case "updateDraftReply":
                return value.ValueKind == JsonValueKind.Object
                    && value.TryGetProperty("bodyMarkdown", out var b) && b.ValueKind == JsonValueKind.String
                    ? b.GetString()
                    : null;
            default:
                return null;
        }
    }

    private static IResult? ValidatePatch(string kind, JsonElement value)
    {
        // Required strings are null-checked BEFORE any .Length / regex call so a malformed payload
        // returns 4xx instead of throwing NullReferenceException → 500.
        switch (kind)
        {
            case "newDraftComment":
                {
                    if (!TryDeserialize<NewDraftCommentPayload>(value, out var ndc))
                        return Results.BadRequest(new { error = "patch-shape-invalid" });
                    if (string.IsNullOrWhiteSpace(ndc.BodyMarkdown))
                        return Results.BadRequest(new { error = "body-empty" });
                    if (ndc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    if (string.IsNullOrEmpty(ndc.AnchoredSha))
                        return Results.BadRequest(new { error = "anchored-sha-missing" });
                    if (!Sha40.IsMatch(ndc.AnchoredSha) && !Sha64.IsMatch(ndc.AnchoredSha))
                        return Results.UnprocessableEntity(new { error = "sha-format-invalid" });
                    if (!IsCanonicalFilePath(ndc.FilePath))
                        return Results.UnprocessableEntity(new { error = "file-path-invalid" });
                    return null;
                }
            case "newPrRootDraftComment":
                {
                    if (!TryDeserialize<NewPrRootDraftCommentPayload>(value, out var nprdc))
                        return Results.BadRequest(new { error = "patch-shape-invalid" });
                    if (string.IsNullOrWhiteSpace(nprdc.BodyMarkdown))
                        return Results.BadRequest(new { error = "body-empty" });
                    if (nprdc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    return null;
                }
            case "newDraftReply":
                {
                    if (!TryDeserialize<NewDraftReplyPayload>(value, out var ndr))
                        return Results.BadRequest(new { error = "patch-shape-invalid" });
                    if (string.IsNullOrWhiteSpace(ndr.BodyMarkdown))
                        return Results.BadRequest(new { error = "body-empty" });
                    if (ndr.BodyMarkdown.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    if (string.IsNullOrEmpty(ndr.ParentThreadId))
                        return Results.BadRequest(new { error = "parent-thread-id-missing" });
                    if (!ParentThreadId.IsMatch(ndr.ParentThreadId))
                        return Results.UnprocessableEntity(new { error = "thread-id-format-invalid" });
                    return null;
                }
            case "updateDraftComment":
                {
                    if (!TryDeserialize<UpdateDraftCommentPayload>(value, out var udc))
                        return Results.BadRequest(new { error = "patch-shape-invalid" });
                    if (string.IsNullOrWhiteSpace(udc.BodyMarkdown))
                        return Results.BadRequest(new { error = "body-empty" });
                    if (udc.BodyMarkdown.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    return null;
                }
            case "updateDraftReply":
                {
                    if (!TryDeserialize<UpdateDraftPayload>(value, out var udr))
                        return Results.BadRequest(new { error = "patch-shape-invalid" });
                    if (string.IsNullOrWhiteSpace(udr.BodyMarkdown))
                        return Results.BadRequest(new { error = "body-empty" });
                    if (udr.BodyMarkdown.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    return null;
                }
            case "deleteDraftComment":
            case "deleteDraftReply":
                return TryDeserialize<DeleteDraftPayload>(value, out var del) && !string.IsNullOrEmpty(del.Id)
                    ? null : Results.BadRequest(new { error = "patch-shape-invalid" });
            case "overrideStale":
                return TryDeserialize<OverrideStalePayload>(value, out var os) && !string.IsNullOrEmpty(os.Id)
                    ? null : Results.BadRequest(new { error = "patch-shape-invalid" });
            case "draftSummaryMarkdown":
                {
                    if (value.ValueKind == JsonValueKind.Null) return null;  // explicit clear is valid
                    if (value.ValueKind != JsonValueKind.String) return Results.BadRequest(new { error = "patch-shape-invalid" });
                    var summary = value.GetString();
                    if (summary is not null && summary.Length > BodyMarkdownMaxChars)
                        return Results.UnprocessableEntity(new { error = "body-too-large" });
                    return null;
                }
            case "draftVerdict":
                {
                    if (value.ValueKind == JsonValueKind.Null) return null;  // explicit clear is valid
                    var verdict = value.ValueKind == JsonValueKind.String ? value.GetString() : null;
                    if (verdict is not "approve" and not "requestChanges" and not "comment")
                        return Results.BadRequest(new { error = "verdict-invalid" });
                    return null;
                }
            default:
                return null;
        }
    }

    private static bool TryDeserialize<T>(JsonElement value, out T result) where T : class
    {
        try
        {
            var parsed = value.Deserialize<T>(Api);
            result = parsed!;
            return parsed is not null;
        }
        catch (JsonException)
        {
            result = null!;
            return false;
        }
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

    private static ReviewSessionState NewEmptySession() => new(
        LastViewedHeadSha: null, LastSeenCommentId: null,
        PendingReviewId: null, PendingReviewCommitOid: null,
        ViewedFiles: new Dictionary<string, string>(),
        DraftComments: Array.Empty<DraftComment>(),
        DraftReplies: Array.Empty<DraftReply>(),
        DraftSummaryMarkdown: null, DraftVerdict: null,
        DraftVerdictStatus: DraftVerdictStatus.Draft);

    // Shared with PrReloadEndpoints — keep `internal` visibility.
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
