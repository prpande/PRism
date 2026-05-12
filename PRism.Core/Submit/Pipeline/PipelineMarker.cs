using System.Text;
using System.Text.RegularExpressions;

namespace PRism.Core.Submit.Pipeline;

// Marker injection / extraction for the resumable submit pipeline (spec § 4). The marker is an
// HTML comment footer the pipeline appends to every thread/reply body it posts to GitHub:
//
//     <body>\n\n<!-- prism:client-id:<DraftId> -->
//
// On a retry after a lost-response window, FindOwnPendingReviewAsync's snapshot still carries the
// marker on the server-side thread (C7 verified the marker survives GitHub's body round-trip), so
// the pipeline can adopt the server thread instead of double-posting (§ 5.2 step 3). The marker is
// never user-visible code — the composer rejects bodies containing the prefix substring (PR3), and
// Resume strips it on import (PR5).
//
// Body-cap note: GitHub caps review-comment bodies at ~65 536 chars. The composer's PUT /draft
// endpoint (PR3) reserves room for the marker (`Prefix.Length + Suffix.Length` + the draft id +
// the "\n\n" separator + a possible fence-close), so a body that arrives here always fits once the
// marker is appended. Inject does not truncate; if an over-cap body ever reaches it, GitHub rejects
// the AttachThread call and the pipeline surfaces a Failed outcome (retryable after the user trims).
internal static class PipelineMarker
{
    public const string Prefix = "<!-- prism:client-id:";
    private const string Suffix = " -->";

    // GitHub's documented review-comment body limit; exposed so composer-side caps can subtract the
    // marker overhead (Prefix + draft id + Suffix + separators) from it.
    public const int GitHubReviewBodyMaxChars = 65536;

    // Matches the marker exactly as appended — <!-- prism:client-id:<id> --> — only at end-of-body
    // (trailing whitespace/newlines allowed). A mid-body occurrence is NOT a marker (the composer
    // rejects those; a stray substring in prose must not be mistaken for an adoptable thread id).
    private static readonly Regex EndMarkerRegex = new(
        @"<!-- prism:client-id:(?<id>[^\s>]+) -->\s*\z",
        RegexOptions.Compiled);

    // A line whose first run (after ≤3 leading spaces, per CommonMark) is a code-fence opener
    // (3+ backticks or 3+ tildes). The ≤3-space cap matters: a line indented 4+ spaces is an
    // *indented* code block, not a fence — treating a literal ``` on such a line as a fence opener
    // would make Inject append a stray closing fence that itself opens an unclosed fenced block at
    // column 0, swallowing the marker into rendered text. The `rest` group is the info string on an
    // opening fence (ignored) or — on a candidate closing fence — must be whitespace-only for the
    // line to actually close the fence.
    private static readonly Regex FenceLineRegex = new(
        @"^ {0,3}(?<fence>`{3,}|~{3,})(?<rest>.*)$",
        RegexOptions.Compiled);

    public static string Inject(string body, string draftId)
    {
        ArgumentNullException.ThrowIfNull(body);
        ArgumentException.ThrowIfNullOrEmpty(draftId);

        var sb = new StringBuilder(body);

        // Re-close any unclosed code fence so the marker lands outside it.
        var openFence = DetectUnclosedFence(body);
        if (openFence is { } fence)
        {
            if (!body.EndsWith('\n')) sb.Append('\n');
            sb.Append(new string(fence.Ch, fence.Len));
            sb.Append('\n');
        }

        sb.Append("\n\n");
        sb.Append(Prefix);
        sb.Append(draftId);
        sb.Append(Suffix);
        return sb.ToString();
    }

    public static string? Extract(string body)
    {
        if (string.IsNullOrEmpty(body)) return null;
        var match = EndMarkerRegex.Match(body);
        return match.Success ? match.Groups["id"].Value : null;
    }

    // Composer-side rejection helper (called from PR3's PUT /draft). True if the marker prefix
    // appears OUTSIDE any fenced code block — a marker inside a fence renders as literal text and
    // is not part of the adoption attack surface.
    public static bool ContainsMarkerPrefix(string body)
    {
        if (string.IsNullOrEmpty(body)) return false;
        return StripFencedBlocks(body).Contains(Prefix, StringComparison.Ordinal);
    }

    // Walks the body line-by-line tracking fence state; returns the still-open fence (char + run
    // length) at end-of-body, or null if every fence is balanced. A line that looks like a fence
    // but doesn't qualify as a closer (wrong char, shorter run, or trailing non-whitespace) is
    // treated as content inside the open fence — this is what makes a ```` block containing a ```
    // example, or an inline-prose ``` mention, behave correctly instead of skewing an odd/even count.
    private static (char Ch, int Len)? DetectUnclosedFence(string body)
    {
        (char Ch, int Len)? open = null;
        foreach (var line in body.Split('\n'))
        {
            var m = FenceLineRegex.Match(line);
            if (!m.Success) continue;

            var run = m.Groups["fence"].Value;
            var ch = run[0];
            var len = run.Length;
            var rest = m.Groups["rest"].Value;

            if (open is null)
            {
                open = (ch, len);  // opening fence; `rest` is the info string — ignored.
            }
            else if (ch == open.Value.Ch && len >= open.Value.Len && string.IsNullOrWhiteSpace(rest))
            {
                open = null;       // valid closing fence.
            }
            // else: a fence-looking line inside the open fence — content, not a delimiter.
        }
        return open;
    }

    private static string StripFencedBlocks(string body)
    {
        var sb = new StringBuilder();
        (char Ch, int Len)? open = null;
        foreach (var line in body.Split('\n'))
        {
            var m = FenceLineRegex.Match(line);
            if (m.Success)
            {
                var run = m.Groups["fence"].Value;
                var ch = run[0];
                var len = run.Length;
                var rest = m.Groups["rest"].Value;
                if (open is null) { open = (ch, len); continue; }
                if (ch == open.Value.Ch && len >= open.Value.Len && string.IsNullOrWhiteSpace(rest))
                {
                    open = null;
                    continue;
                }
                // Fence-looking content line inside the open fence — drop with the rest of the block.
                continue;
            }
            if (open is null) sb.Append(line).Append('\n');
        }
        return sb.ToString();
    }
}
