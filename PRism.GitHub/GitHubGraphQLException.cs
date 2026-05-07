namespace PRism.GitHub;

/// <summary>
/// Thrown when GitHub's GraphQL endpoint returns a 200 response that nonetheless
/// reports execution-level errors with no usable data payload. Distinguishes
/// "GraphQL ran but failed" from "transport failure" (HttpRequestException) and
/// from "GraphQL ran cleanly and reported pullRequest:null" (return null at the
/// caller).
/// </summary>
public sealed class GitHubGraphQLException : Exception
{
    /// <summary>The raw <c>errors</c> array as a JSON string for diagnostic logging.</summary>
    public string ErrorsJson { get; }

    public GitHubGraphQLException()
        : base("GitHub GraphQL request returned errors with no usable data.")
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message)
        : base(message)
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message, Exception innerException)
        : base(message, innerException)
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message, string errorsJson)
        : base(message)
    {
        ErrorsJson = errorsJson ?? "[]";
    }
}
