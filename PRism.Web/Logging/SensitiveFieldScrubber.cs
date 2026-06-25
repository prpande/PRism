namespace PRism.Web.Logging;

// Spec § 6.2 + § 10.6 P2.8 + § 18.2 (S3 PR5) + on-disk-log-writer spec § 4.7:
// scrub fields named `subscriberId`, `pat`, `token`, `pendingReviewId`, `threadId`,
// `replyCommentId`, `login` (case-insensitive). `body` / `content` / `responseBody` are
// intentionally NOT blocked because they're load-bearing for debuggability of mark-viewed /
// files/viewed / submit-pipeline failures.
//
// Public surface is two methods:
//   - Scrub(name, value) — redact + truncate strings > 1024 chars with a
//     `[truncated, original-length: N]` suffix. Existing contract, kept unchanged for
//     direct callers (currently `PrDraftsDiscardAllEndpoint.cs:97`).
//   - ScrubFieldName(name, value) — redaction-only, no truncation. Used by the file sink
//     (`FileLogger.Log<TState>`) when re-formatting structured args; the file sink wants
//     faithful re-substitution against scrubbed values, NOT truncated ones (truncation
//     would diverge the on-disk output from the console output for the same event).
//     `internal sealed`-scoped — external direct callers should use `Scrub` which carries
//     the size guard. Future internal callers acknowledge in code review that the size
//     guard is theirs to handle.
internal sealed class SensitiveFieldScrubber
{
    public const int MaxStringLength = 1024;

    // The single redaction token used across the logging path. Both the field-name scrubber
    // (here) and the free-text backstop (LogScrub) write this, so a log file carries one marker.
    public const string RedactionMarker = "[REDACTED]";

    private static readonly string[] BlockedFieldNames =
    {
        "subscriberId",
        "pat",
        "token",
        "pendingReviewId",   // S5 PR3 — live GitHub PullRequestReview node id
        "threadId",          // S5 PR3 — live GitHub PullRequestReviewThread node id
        "replyCommentId",    // S5 PR3 — live GitHub PullRequestReviewComment node id
        "login",             // 2026-05-18: preventive — GitHub-supplied username; PII per multi-account-scaffold deferral.
    };

    public static object? ScrubFieldName(string fieldName, object? value)
    {
        ArgumentNullException.ThrowIfNull(fieldName);

        foreach (var blocked in BlockedFieldNames)
        {
            if (string.Equals(blocked, fieldName, StringComparison.OrdinalIgnoreCase))
                return RedactionMarker;
        }

        return value;
    }

    public static object? Scrub(string fieldName, object? value)
    {
        var scrubbed = ScrubFieldName(fieldName, value);

        if (scrubbed is string s && s.Length > MaxStringLength)
            return $"{s[..MaxStringLength]}[truncated, original-length: {s.Length}]";

        return scrubbed;
    }
}
