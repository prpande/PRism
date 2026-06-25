using System.Text.RegularExpressions;

namespace PRism.Web.Logging;

internal static partial class LogScrub
{
    // Free-text secret shapes. Alternation, left-to-right:
    //   1. (?<=Bearer\s+)\S+   — the token after an HTTP "Bearer " scheme; the scheme word is
    //      kept (lookbehind, not consumed) for debuggability, only the credential is redacted.
    //   2. GitHub PAT prefixes — personal-access / OAuth / user / server token shapes.
    //   3. sk-ant-…            — Anthropic API keys (claude CLI subprocess error text).
    // Redacts to SensitiveFieldScrubber.RedactionMarker so a single log file carries one marker.
    [GeneratedRegex(@"(?<=Bearer\s+)\S+|(?:ghp_|github_pat_|gho_|ghu_|ghs_)[A-Za-z0-9_]+|sk-ant-[A-Za-z0-9_-]+")]
    private static partial Regex PatPattern();

    public static string Apply(string message)
    {
        ArgumentNullException.ThrowIfNull(message);
        return PatPattern().Replace(message, SensitiveFieldScrubber.RedactionMarker);
    }
}
