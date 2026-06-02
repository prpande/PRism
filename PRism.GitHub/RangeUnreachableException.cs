namespace PRism.GitHub;

/// <summary>
/// Thrown by <see cref="GitHubReviewService.GetDiffAsync"/> when the requested
/// (baseSha, headSha) pair is not addressable on GitHub — typically because the
/// commits were garbage-collected after a force-push. The <c>/api/pr/.../diff</c>
/// endpoint catches this and translates it into
/// <c>ProblemDetails { type: "/diff/range-unreachable" }</c> with HTTP 422
/// (spec § 5.1 + § 6.1 + § 8) so the client renders the typed "diff unavailable"
/// message instead of surfacing an unhandled 500.
/// </summary>
public sealed class RangeUnreachableException : Exception
{
    public string BaseSha { get; }
    public string HeadSha { get; }

    public RangeUnreachableException()
        : base("Diff range is not reachable on GitHub.")
    {
        BaseSha = string.Empty;
        HeadSha = string.Empty;
    }

    public RangeUnreachableException(string message)
        : base(message)
    {
        BaseSha = string.Empty;
        HeadSha = string.Empty;
    }

    public RangeUnreachableException(string message, Exception innerException)
        : base(message, innerException)
    {
        BaseSha = string.Empty;
        HeadSha = string.Empty;
    }

    public RangeUnreachableException(string baseSha, string headSha)
        : base($"Diff range {baseSha}..{headSha} is no longer reachable on GitHub (likely garbage-collected after a force-push).")
    {
        BaseSha = baseSha;
        HeadSha = headSha;
    }
}
