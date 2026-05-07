namespace PRism.GitHub;

public static class HostUrlResolver
{
    public static Uri ApiBase(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
            throw new ArgumentException("github.host is required.", nameof(host));

        if (!Uri.TryCreate(host, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https"))
            throw new ArgumentException($"github.host must be an absolute http(s) URL, got '{host}'.", nameof(host));

        if (u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
            return new Uri("https://api.github.com/");

        var trimmed = host.TrimEnd('/');
        return new Uri($"{trimmed}/api/v3/");
    }

    /// <summary>
    /// Resolves the absolute GraphQL endpoint URL.
    /// </summary>
    /// <remarks>
    /// On github.com, GraphQL lives under <c>https://api.github.com/graphql</c>.
    /// On GitHub Enterprise Server, the GraphQL endpoint is at <c>{host}/api/graphql</c>
    /// — note the absence of <c>/v3</c>: REST is <c>{host}/api/v3/</c> but GraphQL is
    /// <c>{host}/api/graphql</c>. This split is GitHub's documented contract.
    /// </remarks>
    public static Uri GraphQlEndpoint(string host)
    {
        if (string.IsNullOrWhiteSpace(host))
            throw new ArgumentException("github.host is required.", nameof(host));

        if (!Uri.TryCreate(host, UriKind.Absolute, out var u) || (u.Scheme != "http" && u.Scheme != "https"))
            throw new ArgumentException($"github.host must be an absolute http(s) URL, got '{host}'.", nameof(host));

        if (u.Host.Equals("github.com", StringComparison.OrdinalIgnoreCase))
            return new Uri("https://api.github.com/graphql");

        var trimmed = host.TrimEnd('/');
        return new Uri($"{trimmed}/api/graphql");
    }
}
