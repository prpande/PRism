using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Feedback;

// Allowlisted feedback fields. Category/Summary/Details are user input;
// RoutePattern/Platform are machine context; Version + SubmittedAt are stamped by
// the endpoint (not trusted from the client).
public sealed record FeedbackContent(
    string Category,
    string Summary,
    string Details,
    string RoutePattern,
    string Platform,
    string Version,
    DateTimeOffset SubmittedAt);

public enum FeedbackOutcome
{
    Created,
    // GitHub returned 401/403/404/422 — the user's token can't create the issue.
    // The frontend falls back to the prefilled issues/new link.
    CannotCreate,
}

[SuppressMessage("Design", "CA1054:URI-like parameters should not be strings",
    Justification = "HtmlUrl is a raw URL string returned from the GitHub API.")]
[SuppressMessage("Design", "CA1056:URI-like properties should not be strings",
    Justification = "HtmlUrl is a raw URL string returned from the GitHub API.")]
public sealed record FeedbackCreateResult(FeedbackOutcome Outcome, int? IssueNumber, string? HtmlUrl)
{
    public static FeedbackCreateResult Created(int issueNumber, string htmlUrl) =>
        new(FeedbackOutcome.Created, issueNumber, htmlUrl);

    public static FeedbackCreateResult CannotCreate() =>
        new(FeedbackOutcome.CannotCreate, null, null);
}

// Single-method seam. Interface (not concrete) so endpoint tests substitute a fake
// via services.RemoveAll/AddSingleton — the repo's pattern for GitHub-touching
// services (cf. IReviewAuth/IReviewSubmitter, also in PRism.Core).
public interface IFeedbackSubmitter
{
    // Created on 201; CannotCreate on 401/403/404/422; throws HttpRequestException
    // on genuine transport/5xx so the endpoint maps it to 500.
    Task<FeedbackCreateResult> CreateFeedbackIssueAsync(FeedbackContent content, CancellationToken ct);
}
