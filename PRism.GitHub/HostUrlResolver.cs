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
}
