using PRism.Core.Contracts;
using PRism.Core.PrDetail;

namespace PRism.Web.Endpoints;

internal static class RequireSubscribed
{
    /// <summary>null => subscribed (proceed). Non-null => 403 result the caller returns.
    /// Status moves 401 -> 403; code stays "unauthorized" (a KNOWN_SUBMIT_ERROR_CODES value
    /// the frontend maps), so no FE .code branch regresses.</summary>
    internal static IResult? Check(IActivePrCache cache, PrReference prRef) =>
        cache.IsSubscribed(prRef)
            ? null
            : Results.Json(
                new SubmitErrorDto("unauthorized", "Subscribe to this PR before making changes."),
                statusCode: StatusCodes.Status403Forbidden);
}
