using System.Net;

namespace PRism.Web.Endpoints;

internal static class GitHubErrorMapper
{
    internal static SubmitErrorDto Map(Exception ex)
    {
        var (code, message) = (ex as HttpRequestException)?.StatusCode switch
        {
            HttpStatusCode.Forbidden =>
                ("github-forbidden", "GitHub rejected the request (forbidden). Check your token's permissions."),
            HttpStatusCode.Unauthorized =>
                ("github-unauthorized", "GitHub authentication failed. Reconnect your account."),
            HttpStatusCode.UnprocessableEntity =>
                ("github-validation-error", "GitHub rejected the request as invalid."),
            _ => ("github-network-error", "Couldn't reach GitHub. Try again."),
        };
        return new SubmitErrorDto(code, message);
    }

    // #605 item E — surface auth-class GitHub failures with their real HTTP status instead of
    // flattening every upstream error to 502. A revoked / under-scoped token reported as 502 reads
    // as a transient upstream blip → the client futilely retries; 401/403 tells it to re-auth. The
    // sanitized `code` (github-unauthorized / github-forbidden) is unchanged, so frontend callers —
    // which branch on `code`, never the literal HTTP status — keep working.
    internal static IResult ToResult(Exception ex)
    {
        var dto = Map(ex);
        var status = dto.Code switch
        {
            "github-unauthorized" => StatusCodes.Status401Unauthorized,
            "github-forbidden" => StatusCodes.Status403Forbidden,
            _ => StatusCodes.Status502BadGateway,
        };
        return Results.Json(dto, statusCode: status);
    }
}
