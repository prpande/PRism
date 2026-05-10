using PRism.Core.State;

namespace PRism.Web.Endpoints;

// GET /api/pr/{ref}/draft response shape. Enum fields serialize as kebab-case strings via
// JsonStringEnumConverter on JsonSerializerOptionsFactory.Api (matches DraftStatus =
// "draft" | "moved" | "stale" on the TS side per spec § 5.9).
internal sealed record ReviewSessionDto(
    DraftVerdict? DraftVerdict,
    DraftVerdictStatus DraftVerdictStatus,
    string? DraftSummaryMarkdown,
    IReadOnlyList<DraftCommentDto> DraftComments,
    IReadOnlyList<DraftReplyDto> DraftReplies,
    IReadOnlyList<IterationOverrideDto> IterationOverrides,
    string? PendingReviewId,
    string? PendingReviewCommitOid,
    FileViewStateDto FileViewState);

internal sealed record DraftCommentDto(
    string Id,
    string? FilePath,
    int? LineNumber,
    string? Side,
    string? AnchoredSha,
    string? AnchoredLineContent,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

internal sealed record DraftReplyDto(
    string Id,
    string ParentThreadId,
    string? ReplyCommentId,
    string BodyMarkdown,
    DraftStatus Status,
    bool IsOverriddenStale);

// Empty in S4 — spec § 3 / S3 placeholder for future iteration-override metadata.
internal sealed record IterationOverrideDto();

internal sealed record FileViewStateDto(IReadOnlyDictionary<string, string> ViewedFiles);

// PUT /api/pr/{ref}/draft request shape. Server enforces "exactly one field set"
// per spec § 4.2 — see PrDraftEndpoints.EnumerateSetFields and the BadRequest
// response when count != 1.
internal sealed record ReviewSessionPatch(
    string? DraftVerdict,
    string? DraftSummaryMarkdown,
    NewDraftCommentPayload? NewDraftComment,
    NewPrRootDraftCommentPayload? NewPrRootDraftComment,
    UpdateDraftCommentPayload? UpdateDraftComment,
    DeleteDraftPayload? DeleteDraftComment,
    NewDraftReplyPayload? NewDraftReply,
    UpdateDraftPayload? UpdateDraftReply,
    DeleteDraftPayload? DeleteDraftReply,
    bool? ConfirmVerdict,
    bool? MarkAllRead,
    OverrideStalePayload? OverrideStale);

internal sealed record NewDraftCommentPayload(
    string FilePath, int LineNumber, string Side,
    string AnchoredSha, string AnchoredLineContent, string BodyMarkdown);

internal sealed record NewPrRootDraftCommentPayload(string BodyMarkdown);

internal sealed record UpdateDraftCommentPayload(string Id, string BodyMarkdown);
internal sealed record UpdateDraftPayload(string Id, string BodyMarkdown);
internal sealed record DeleteDraftPayload(string Id);
internal sealed record NewDraftReplyPayload(string ParentThreadId, string BodyMarkdown);
internal sealed record OverrideStalePayload(string Id);

// Response shape for new-* patches. The frontend uses AssignedId to bind a new
// composer to the persisted draft id (spec § 5.3 in-flight composer model).
internal sealed record AssignedIdResponse(string AssignedId);
