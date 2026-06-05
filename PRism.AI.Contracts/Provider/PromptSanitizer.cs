namespace PRism.AI.Contracts.Provider;

/// <summary>
/// Wraps attacker-controllable text (PR diffs, titles, comments — and user-edited prompts) as DATA
/// inside named sentinel tags. Any occurrence of the sentinel inside the payload is neutralized
/// (case-insensitively) by inserting a zero-width break, so the model sees exactly one real opening
/// and one real closing tag.
///
/// This is a structural mitigation that REDUCES the chance a payload escapes into the instruction
/// region — it is NOT a guarantee (the zero-width break is defense-in-depth; some tokenizers strip
/// U+200B). Real injection resistance is validated by the P2→P3 injection battery.
/// </summary>
public static class PromptSanitizer
{
    /// <summary>Default cap on wrapped content length (2 MB).</summary>
    public const int DefaultMaxChars = 2_000_000;

    // Zero-width space inserted after the angle bracket to break any sentinel tag found in the
    // payload. Written as an explicit \u200B escape (NOT a literal invisible char) so it survives
    // review and refactors — an editor that strips zero-width characters can't silently disarm it.
    private const char ZeroWidthSpace = '\u200B';

    /// <summary>Wrap <paramref name="content"/> as DATA inside &lt;<paramref name="tag"/>&gt; … &lt;/<paramref name="tag"/>&gt;.</summary>
    public static string WrapAsData(string content, string tag, int maxChars = DefaultMaxChars)
    {
        ArgumentNullException.ThrowIfNull(content);
        ArgumentException.ThrowIfNullOrEmpty(tag);
        if (content.Length > maxChars)
            throw new ArgumentException($"Content length {content.Length} exceeds max {maxChars}.", nameof(content));

        var open = $"<{tag}>";
        var close = $"</{tag}>";

        // Neutralize any verbatim sentinel in the payload (case-insensitive) by inserting a
        // zero-width space (U+200B) after the angle bracket — no longer a parseable tag, still
        // human-readable.
        var neutralizedOpen = $"<{ZeroWidthSpace}{tag}>";
        var neutralizedClose = $"</{ZeroWidthSpace}{tag}>";

        var neutralized = content
            .Replace(open, neutralizedOpen, StringComparison.OrdinalIgnoreCase)
            .Replace(close, neutralizedClose, StringComparison.OrdinalIgnoreCase);

        return $"{open}\n{neutralized}\n{close}";
    }
}
