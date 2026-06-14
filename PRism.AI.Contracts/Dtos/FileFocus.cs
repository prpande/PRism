namespace PRism.AI.Contracts.Dtos;

/// <summary>One ranked changed file. <paramref name="Rationale"/> is a one-sentence, plain-text
/// reviewer-facing justification (LLM free text — render as a text node only; never as HTML/markdown).</summary>
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
