using System.Globalization;
using System.Text.RegularExpressions;

namespace PRism.Core.Contracts;

// Parses GitHub's per-file `patch` field (unified diff format) into DiffHunk[].
// GitHub omits this field for binary files and very large files (>~3MB), in
// which case Parse returns an empty list — the caller (GitHubReviewService)
// surfaces the file in the list with empty hunks and the frontend renders an
// "Empty file" placeholder for that file. Hunk Body INCLUDES the @@ header
// line because the frontend's parseHunkLines (DiffPane.tsx) reads the line
// numbers from the body, not from OldStart/NewStart.
public static partial class PatchParser
{
    [GeneratedRegex(@"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")]
    private static partial Regex HunkHeaderPattern();

    public static IReadOnlyList<DiffHunk> Parse(string? patch)
    {
        if (string.IsNullOrEmpty(patch)) return Array.Empty<DiffHunk>();

        var hunks = new List<DiffHunk>();
        int oldStart = 0, oldLines = 0, newStart = 0, newLines = 0;
        var bodyLines = new List<string>();
        var insideHunk = false;

        foreach (var rawLine in patch.Split('\n'))
        {
            // CRLF defense: GitHub's REST API returns LF-terminated patch text, but
            // a GHES proxy or content-rewrite middleware could inject \r\n. Strip
            // trailing \r so it does not pollute Body content the frontend renders.
            var line = rawLine.TrimEnd('\r');
            if (line.StartsWith("@@", StringComparison.Ordinal))
            {
                if (insideHunk)
                {
                    hunks.Add(new DiffHunk(oldStart, oldLines, newStart, newLines,
                        string.Join('\n', bodyLines)));
                }

                var match = HunkHeaderPattern().Match(line);
                if (!match.Success ||
                    !TryParseGroup(match.Groups[1], 0, out oldStart) ||
                    !TryParseGroup(match.Groups[2], 1, out oldLines) ||
                    !TryParseGroup(match.Groups[3], 0, out newStart) ||
                    !TryParseGroup(match.Groups[4], 1, out newLines))
                {
                    // Malformed header (regex miss) or out-of-range numeric capture
                    // (\d+ has no upper bound; values > Int32.MaxValue would otherwise
                    // throw OverflowException and abort the entire diff response).
                    // Drop this block and resume at the next valid header.
                    insideHunk = false;
                    bodyLines.Clear();
                    continue;
                }

                bodyLines.Clear();
                bodyLines.Add(line);
                insideHunk = true;
            }
            else if (insideHunk)
            {
                bodyLines.Add(line);
            }
            // else: pre-header noise (binary-files-differ message, etc.) — skip silently.
        }

        if (insideHunk)
        {
            hunks.Add(new DiffHunk(oldStart, oldLines, newStart, newLines,
                string.Join('\n', bodyLines)));
        }

        return hunks;
    }

    // Optional capture groups (the line-count slots) default to the supplied value
    // when not matched — unified-diff convention is "1" for omitted counts. Required
    // groups (start positions) pass defaultIfMissing=0 but the regex guarantees they
    // match, so the default is unreachable on a successful Match.
    private static bool TryParseGroup(Group g, int defaultIfMissing, out int value)
    {
        if (!g.Success) { value = defaultIfMissing; return true; }
        return int.TryParse(g.Value, NumberStyles.Integer, CultureInfo.InvariantCulture, out value);
    }
}
