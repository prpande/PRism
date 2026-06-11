using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class RequireSubscribed
{
    /// <summary>null => subscribed (proceed). Non-null => 403 result the caller returns.
    /// Status moves 401 -> 403; code stays "unauthorized" (a KNOWN_SUBMIT_ERROR_CODES value
    /// the frontend maps), so no FE .code branch regresses. The per-verb <paramref name="message"/>
    /// is passed by the caller and preserved byte-for-byte from the prior inline guards — the
    /// frontend surfaces it for comment/root-comment errors (api/comment.ts, api/rootComment.ts),
    /// so only the status number changes, not the envelope.</summary>
    internal static IResult? Check(IActivePrCache cache, PrReference prRef, string message) =>
        cache.IsSubscribed(prRef)
            ? null
            : Results.Json(
                new SubmitErrorDto("unauthorized", message),
                statusCode: StatusCodes.Status403Forbidden);
}
