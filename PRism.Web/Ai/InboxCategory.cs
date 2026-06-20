using System.Collections.Generic;

namespace PRism.Web.Ai;

/// Kind-of-change category labels for inbox enrichment chips. `Normalize` maps an LLM's
/// free-text answer to a canonical label, or null when the answer is "Other", unknown, or
/// empty — null means "render no chip" (spec §3: we never surface "Other").
internal static class InboxCategory
{
    public static IReadOnlyList<string> PromptLabels { get; } = new[]
    {
        "Feature", "Bug fix", "Refactor", "Docs", "Test-only", "Chore", "Other",
    };

    private static readonly Dictionary<string, string?> Map = new(System.StringComparer.OrdinalIgnoreCase)
    {
        ["feature"] = "Feature", ["feat"] = "Feature",
        ["bug fix"] = "Bug fix", ["bugfix"] = "Bug fix", ["fix"] = "Bug fix", ["bug"] = "Bug fix",
        ["refactor"] = "Refactor", ["refactoring"] = "Refactor",
        ["docs"] = "Docs", ["doc"] = "Docs", ["documentation"] = "Docs",
        ["test-only"] = "Test-only", ["test"] = "Test-only", ["tests"] = "Test-only", ["testing"] = "Test-only",
        ["chore"] = "Chore", ["build"] = "Chore", ["ci"] = "Chore", ["deps"] = "Chore",
        ["other"] = null,
    };

    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        return Map.TryGetValue(raw.Trim(), out var canonical) ? canonical : null;
    }
}
