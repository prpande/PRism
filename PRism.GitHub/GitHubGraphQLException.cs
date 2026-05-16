using System.Text;
using System.Text.Json;

namespace PRism.GitHub;

/// <summary>
/// Thrown when GitHub's GraphQL endpoint returns a 200 response that nonetheless
/// reports execution-level errors. Distinguishes "GraphQL ran but failed" from
/// "transport failure" (HttpRequestException) and from "GraphQL ran cleanly and
/// reported pullRequest:null" (return null at the caller).
///
/// The <see cref="Message"/> property carries the parsed first error so users
/// see "[CODE] message (path: x/y/z)" instead of just "returned 1 error(s)" —
/// surfaced via the SubmitFailedException toast on the submit pipeline. The
/// full <c>errors</c> array stays in <see cref="ErrorsJson"/> for diagnostic
/// logging and for tests that need to verify a specific failure shape.
/// </summary>
public sealed class GitHubGraphQLException : Exception
{
    /// <summary>The raw <c>errors</c> array as a JSON string for diagnostic logging.</summary>
    public string ErrorsJson { get; }

    public GitHubGraphQLException()
        : base("GitHub GraphQL request returned errors with no usable data.")
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message)
        : base(message)
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message, Exception innerException)
        : base(message, innerException)
    {
        ErrorsJson = "[]";
    }

    public GitHubGraphQLException(string message, string errorsJson)
        : base(message)
    {
        ErrorsJson = errorsJson ?? "[]";
    }

    /// <summary>
    /// Formats the first error in <paramref name="errorsJson"/> as a single
    /// human-readable line so the exception's <see cref="Exception.Message"/>
    /// carries actionable detail instead of just an error count. Falls back to
    /// the bare count when parsing fails so a malformed errors array never
    /// turns a callable exception into a thrown formatter.
    ///
    /// Output shape: <c>"GitHub GraphQL: [CODE] message (path: x/y/z) (+ N more)"</c>
    /// where each section is included only when present in the errors array.
    /// </summary>
    public static string FormatErrorsMessage(string errorsJson)
    {
        if (string.IsNullOrEmpty(errorsJson)) return "GitHub GraphQL request returned 0 error(s).";

        try
        {
            using var doc = JsonDocument.Parse(errorsJson);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Array)
                return "GitHub GraphQL request returned errors (non-array payload).";

            var count = root.GetArrayLength();
            if (count == 0) return "GitHub GraphQL request returned 0 error(s).";

            var first = root[0];
            var sb = new StringBuilder("GitHub GraphQL: ");

            // .extensions.code carries machine-readable categories (FORBIDDEN, NOT_FOUND, ...) —
            // useful for downstream branching and for users grep-ing logs by category.
            string? code = null;
            if (first.TryGetProperty("extensions", out var ext)
                && ext.ValueKind == JsonValueKind.Object
                && ext.TryGetProperty("code", out var c)
                && c.ValueKind == JsonValueKind.String)
            {
                code = c.GetString();
            }
            if (!string.IsNullOrEmpty(code)) sb.Append('[').Append(code).Append("] ");

            string? msg = first.TryGetProperty("message", out var m)
                && m.ValueKind == JsonValueKind.String
                ? m.GetString()
                : null;
            sb.Append(msg ?? "(no message)");

            // .path is an array of strings/ints naming the field path that failed
            // (e.g. ["addPullRequestReview"]). Helps a user know which mutation
            // the error came from when the pipeline runs many in sequence.
            if (first.TryGetProperty("path", out var p) && p.ValueKind == JsonValueKind.Array && p.GetArrayLength() > 0)
            {
                sb.Append(" (path: ");
                var firstSeg = true;
                foreach (var seg in p.EnumerateArray())
                {
                    if (!firstSeg) sb.Append('/');
                    firstSeg = false;
                    sb.Append(seg.ValueKind == JsonValueKind.String ? seg.GetString() : seg.ToString());
                }
                sb.Append(')');
            }

            if (count > 1) sb.Append(" (+ ").Append(count - 1).Append(" more)");

            return sb.ToString();
        }
        catch (JsonException)
        {
            return "GitHub GraphQL request returned errors (unparseable payload).";
        }
    }
}
