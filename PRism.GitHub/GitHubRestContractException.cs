namespace PRism.GitHub;

/// <summary>
/// Thrown when a GitHub REST endpoint returns a 2xx whose body violates the
/// expected contract (e.g. a created-comment response missing 'id' or 'created_at').
/// Distinguishes "transport succeeded but the payload is malformed" from a genuine
/// non-2xx transport failure (HttpRequestException). Mirrors GitHubGraphQLException,
/// which plays the same role for 200-with-errors GraphQL responses. (#322)
/// </summary>
public sealed class GitHubRestContractException : Exception
{
    public GitHubRestContractException()
        : base("GitHub REST response violated its expected contract.") { }

    public GitHubRestContractException(string message) : base(message) { }

    public GitHubRestContractException(string message, Exception innerException)
        : base(message, innerException) { }
}
