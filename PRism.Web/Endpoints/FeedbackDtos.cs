namespace PRism.Web.Endpoints;

internal sealed record FeedbackRequestDto(
    string? Category,
    string? Summary,
    string? Details,
    string? RoutePattern,
    string? Platform);

internal sealed record FeedbackResponseDto(int IssueNumber, string HtmlUrl);

internal sealed record FeedbackErrorDto(string Error);
