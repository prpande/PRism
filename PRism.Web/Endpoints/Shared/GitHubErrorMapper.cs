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

    internal static IResult ToResult(Exception ex) =>
        Results.Json(Map(ex), statusCode: StatusCodes.Status502BadGateway);
}
