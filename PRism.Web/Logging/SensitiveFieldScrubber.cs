namespace PRism.Web.Logging;

// Spec § 6.2 + § 10.6 P2.8: scrub fields named `subscriberId`, `pat`, `token`
// (case-insensitive) only — `body` and `content` are intentionally NOT blocked because
// they're load-bearing for debuggability of mark-viewed / files/viewed failures. To
// cap blast radius without losing the useful fields, the policy also truncates any
// string property longer than 1024 chars with a `[truncated, original-length: N]`
// suffix. Used by future ILogger-pipeline integration; for now, callers who handle
// untrusted structured-log values invoke Scrub directly. The wire-up to a logger
// decorator that auto-applies this to every log scope is tracked in the deferrals
// sidecar — no current call site emits a blocked field name as a structured-log
// argument, so the integration is forward-looking, not blocking PoC.
internal sealed class SensitiveFieldScrubber
{
    public const int MaxStringLength = 1024;

    private static readonly string[] BlockedFieldNames =
    {
        "subscriberId",
        "pat",
        "token",
    };

    public static object? Scrub(string fieldName, object? value)
    {
        ArgumentNullException.ThrowIfNull(fieldName);

        foreach (var blocked in BlockedFieldNames)
        {
            if (string.Equals(blocked, fieldName, StringComparison.OrdinalIgnoreCase))
                return "[REDACTED]";
        }

        if (value is string s && s.Length > MaxStringLength)
            return $"{s[..MaxStringLength]}[truncated, original-length: {s.Length}]";

        return value;
    }
}
