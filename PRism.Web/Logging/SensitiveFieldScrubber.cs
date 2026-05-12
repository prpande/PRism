namespace PRism.Web.Logging;

// Spec § 6.2 + § 10.6 P2.8 + § 18.2: scrub fields named `subscriberId`, `pat`, `token`,
// `pendingReviewId`, `threadId`, `replyCommentId` (case-insensitive) only — `body` and
// `content` are intentionally NOT blocked because they're load-bearing for debuggability of
// mark-viewed / files/viewed failures. To cap blast radius without losing the useful fields,
// the policy also truncates any string property longer than 1024 chars with a
// `[truncated, original-length: N]` suffix. Callers who handle live identifiers (e.g. the
// closed/merged bulk-discard courtesy-delete failure log) invoke Scrub directly on the
// structured-log argument; the wire-up to a logger decorator that auto-applies this to every
// log scope is tracked in the deferrals sidecar.
internal sealed class SensitiveFieldScrubber
{
    public const int MaxStringLength = 1024;

    private static readonly string[] BlockedFieldNames =
    {
        "subscriberId",
        "pat",
        "token",
        "pendingReviewId",   // S5 PR3 — live GitHub PullRequestReview node id
        "threadId",          // S5 PR3 — live GitHub PullRequestReviewThread node id
        "replyCommentId",    // S5 PR3 — live GitHub PullRequestReviewComment node id
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
