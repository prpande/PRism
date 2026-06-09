namespace PRism.Web.Ai;

/// <summary>Parses the leading <c>CATEGORY: &lt;value&gt;</c> line the summary prompt emits, validates
/// it against the fixed taxonomy, and strips it from the body. Out-of-enum / missing ⇒ empty category
/// (the no-confident-category fallback). Bounds forged-category injection: a coerced value outside the
/// enum yields "" — never arbitrary output (spec §10).</summary>
internal static class PrCategoryParser
{
    private static readonly HashSet<string> Taxonomy = new(StringComparer.OrdinalIgnoreCase)
    {
        "feature", "fix", "refactor", "docs", "test", "chore", "revert",
    };

    public static (string body, string category) Parse(string raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        var newline = raw.IndexOf('\n', StringComparison.Ordinal);
        var firstLine = (newline >= 0 ? raw[..newline] : raw).TrimEnd('\r');

        const string prefix = "CATEGORY:";
        if (!firstLine.TrimStart().StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            return (raw, "");

        var value = firstLine.TrimStart()[prefix.Length..].Trim();

        // Resolve canonical lowercase entry from the taxonomy set to avoid CA1308
        // (prefer ToUpperInvariant for normalisation). We want the lowercase canonical
        // value, so we ask the set for the stored key rather than calling ToLower on input.
        var category = Taxonomy.TryGetValue(value, out var canonical) ? canonical : "";
        var body = newline >= 0 ? raw[(newline + 1)..] : "";
        return (body, category);
    }
}
