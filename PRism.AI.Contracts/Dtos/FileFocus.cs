namespace PRism.AI.Contracts.Dtos;

/// <summary>One ranked changed file. <paramref name="Rationale"/> is multi-line markdown: the first line
/// is a short headline (≤ ~8 words), followed by a newline-separated bulleted explanation. The first line
/// is rendered as a plain-text headline; the remainder renders as markdown in the Hotspots expanded panel.
/// LLM free text — already bidi/control-char sanitized by FileFocusParser; rendered via MarkdownRenderer
/// (no raw HTML).</summary>
public sealed record FileFocus(string Path, FocusLevel Level, string Rationale);

public enum FocusLevel
{
    High,
    Medium,
    Low,
}

/// <summary>Response envelope for the file-focus seam. The <paramref name="Fallback"/> flag is a
/// RESPONSE-level signal (the harness produced an all-medium fallback because real ranking failed —
/// spec §5.6); it has no per-file home, hence the envelope. Cached as-is so a cache-hit returns the
/// flag too (spec §4/§6).</summary>
public sealed record FileFocusResult(IReadOnlyList<FileFocus> Entries, bool Fallback = false);
