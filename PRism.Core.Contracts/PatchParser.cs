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

        foreach (var line in patch.Split('\n'))
        {
            if (line.StartsWith("@@", StringComparison.Ordinal))
            {
                if (insideHunk)
                {
                    hunks.Add(new DiffHunk(oldStart, oldLines, newStart, newLines,
                        string.Join('\n', bodyLines)));
                }

                var match = HunkHeaderPattern().Match(line);
                if (!match.Success)
                {
                    // Malformed header — drop this block and resume at the next valid one.
                    insideHunk = false;
                    bodyLines.Clear();
                    continue;
                }

                oldStart = int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture);
                oldLines = match.Groups[2].Success
                    ? int.Parse(match.Groups[2].Value, CultureInfo.InvariantCulture)
                    : 1;
                newStart = int.Parse(match.Groups[3].Value, CultureInfo.InvariantCulture);
                newLines = match.Groups[4].Success
                    ? int.Parse(match.Groups[4].Value, CultureInfo.InvariantCulture)
                    : 1;
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
}
