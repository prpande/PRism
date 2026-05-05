using System.Text.RegularExpressions;

namespace PRism.Web.Logging;

internal static partial class LogScrub
{
    [GeneratedRegex(@"(ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]+")]
    private static partial Regex PatPattern();

    public static string Apply(string message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return PatPattern().Replace(message, "<redacted>");
    }
}
