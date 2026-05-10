namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class LineMatching
{
    public sealed record MatchSet(
        IReadOnlyList<int> ExactAtOriginal,
        IReadOnlyList<int> ExactElsewhere,
        IReadOnlyList<int> WhitespaceEquivAll);

    public static MatchSet Compute(string fileContent, int originalLine, string anchoredContent, string filePath)
    {
        var lines = SplitLines(fileContent);
        var exactAtOriginal = new List<int>();
        var exactElsewhere = new List<int>();
        var whitespaceEquiv = new List<int>();

        var allowWhitespaceEquiv = WhitespaceInsignificantExtensions.IsAllowed(filePath);

        for (int i = 0; i < lines.Count; i++)
        {
            int oneBasedLine = i + 1;
            if (lines[i] == anchoredContent)
            {
                if (oneBasedLine == originalLine) exactAtOriginal.Add(oneBasedLine);
                else exactElsewhere.Add(oneBasedLine);
            }
            else if (allowWhitespaceEquiv && WhitespaceEquivalent(lines[i], anchoredContent))
            {
                whitespaceEquiv.Add(oneBasedLine);
            }
        }

        return new MatchSet(exactAtOriginal, exactElsewhere, whitespaceEquiv);
    }

    private static List<string> SplitLines(string content)
    {
        // Strip trailing CR from each split line so CRLF↔LF flips don't leak into the
        // exact-string compare. The anchored content is NOT trimmed — if the stored anchor
        // has a trailing \r it falls through to the whitespace-equivalent path.
        var lines = content
            .Split('\n')
            .Select(l => l.TrimEnd('\r'))
            .ToList();

        // Drop exactly one trailing empty element when the file ends with `\n` — that's
        // the trailing-newline artifact (POSIX text-file convention), not a real line N+1
        // a draft could anchor to. Without this, an empty anchored content (rare; user
        // anchored on a blank end-of-file) would produce a spurious whitespace-equiv match
        // on the phantom line, and the line count would be off-by-one for matrix
        // semantics tied to file length.
        if (content.Length > 0 && content[^1] == '\n' && lines.Count > 0 && lines[^1].Length == 0)
        {
            lines.RemoveAt(lines.Count - 1);
        }

        return lines;
    }

    private static bool WhitespaceEquivalent(string a, string b)
        => Normalize(a) == Normalize(b);

    private static string Normalize(string s)
    {
        // Strips ALL whitespace (not just leading/trailing or runs) so reformatted lines
        // re-anchor correctly. `foo(x, y)` and `foo(x,y)` are whitespace-equivalent under
        // this normalization. Intentional for the PoC — auto-formatter changes shouldn't
        // strand drafts.
        return string.Concat(s.Where(c => !char.IsWhiteSpace(c)));
    }
}
