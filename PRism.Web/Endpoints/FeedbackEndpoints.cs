using Microsoft.AspNetCore.Http;
using PRism.Core.Feedback;

namespace PRism.Web.Endpoints;

internal static class FeedbackEndpoints
{
    private const int MaxSummary = 120;
    private const int MaxDetails = 4000;
    private const int MaxRoutePattern = 256;
    private const int MaxPlatform = 128;
    private static readonly string[] Categories = ["Bug", "Idea", "Other"];

    public static IEndpointRouteBuilder MapFeedback(this IEndpointRouteBuilder app)
    {
        ArgumentNullException.ThrowIfNull(app);
        app.MapPost("/api/feedback", SubmitAsync);
        return app;
    }

    private static async Task<IResult> SubmitAsync(
        FeedbackRequestDto? request,
        IFeedbackSubmitter submitter,
        CancellationToken ct)
    {
        if (request is null
            || string.IsNullOrWhiteSpace(request.Category)
            || string.IsNullOrWhiteSpace(request.Summary)
            || string.IsNullOrWhiteSpace(request.Details))
            return Results.BadRequest(new FeedbackErrorDto("missing-required-fields"));

        if (!Array.Exists(Categories, c => c == request.Category))
            return Results.BadRequest(new FeedbackErrorDto("invalid-category"));

        if (request.Summary!.Length > MaxSummary
            || request.Details!.Length > MaxDetails
            || (request.RoutePattern?.Length ?? 0) > MaxRoutePattern
            || (request.Platform?.Length ?? 0) > MaxPlatform)
            return Results.BadRequest(new FeedbackErrorDto("field-too-long"));

        // Version + timestamp are stamped server-side (not trusted from the client).
        // RoutePattern/Platform pass through as the allowlisted machine context, with
        // line endings stripped so a client can't inject extra context lines (e.g.
        // "/inbox\nversion: 9.9.9") into the fenced block. No arbitrary client object
        // is forwarded into the issue body.
        var content = new FeedbackContent(
            request.Category!,
            request.Summary!.Trim(),
            request.Details!.Trim(),
            (request.RoutePattern ?? "unknown").ReplaceLineEndings(" "),
            (request.Platform ?? "unknown").ReplaceLineEndings(" "),
            AppVersion.Current,
            DateTimeOffset.UtcNow);

        var result = await submitter.CreateFeedbackIssueAsync(content, ct).ConfigureAwait(false);
        return result.Outcome == FeedbackOutcome.Created
            ? Results.Created(result.HtmlUrl ?? string.Empty,
                new FeedbackResponseDto(result.IssueNumber!.Value, result.HtmlUrl ?? string.Empty))
            : Results.Json(new FeedbackErrorDto("cannot-create"),
                statusCode: StatusCodes.Status422UnprocessableEntity);
    }
}
