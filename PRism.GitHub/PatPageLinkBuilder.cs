namespace PRism.GitHub;

public static class PatPageLinkBuilder
{
    public static string Build(string host)
    {
        ArgumentNullException.ThrowIfNull(host);
        var trimmed = host.TrimEnd('/');
        return $"{trimmed}/settings/personal-access-tokens/new";
    }
}
