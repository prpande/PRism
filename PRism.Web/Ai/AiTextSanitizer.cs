using System.Text;

namespace PRism.Web.Ai;

/// <summary>Shared sanitizer for LLM-authored text that will be rendered as markdown on an AI surface
/// (summary body, file-focus rationale, hunk-annotation body). Every parser that feeds the frontend
/// <c>MarkdownRenderer</c> MUST route its free-text fields through here so the strip set stays
/// consistent across surfaces — an asymmetry (one parser stripping, another not) reopens the bidi
/// spoofing vector on whichever surface skips it (#465).</summary>
internal static class AiTextSanitizer
{
    /// <summary>Strip category-Cc control characters — EXCEPT the whitespace controls \n/\r/\t, which
    /// carry the text's markdown structure (bullet lists, fenced code). Stripping them collapsed a
    /// multi-bullet annotation into a single paragraph in live mode (#465); the placeholder bypasses
    /// the parsers, which is why sample mode looked fine. Also strip the Unicode bidi / directional-
    /// formatting characters that are category Cf (so <c>char.IsControl</c> misses them): U+061C (ALM),
    /// U+200E/U+200F (LRM/RLM), U+202A–U+202E (LRE…RLO/PDF), U+2066–U+2069 (LRI…PDI). Compared as numeric
    /// code points (hex literals) rather than char escapes so the source stays pure ASCII — an editor
    /// that strips zero-width characters can't silently disarm the filter (PromptSanitizer's discipline).
    /// Bounds what an injected payload can render (spec §5/§10/§12). All targets are BMP single UTF-16
    /// units, so a per-char scan is exact. Returns <see cref="string.Empty"/> for null/empty input;
    /// callers <c>.Trim()</c> if they need it.</summary>
    internal static string StripDangerous(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return string.Empty;
        var sb = new StringBuilder(raw.Length);
        foreach (var ch in raw)
        {
            if (char.IsControl(ch) && ch is not ('\n' or '\r' or '\t')) continue;   // Cc except whitespace
            int cp = ch;
            if (cp == 0x061C) continue;                       // ALM (Arabic Letter Mark)
            if (cp is 0x200E or 0x200F) continue;             // LRM / RLM
            if (cp >= 0x202A && cp <= 0x202E) continue;       // LRE..RLO/PDF
            if (cp >= 0x2066 && cp <= 0x2069) continue;       // LRI..PDI
            sb.Append(ch);
        }
        return sb.ToString();
    }
}
