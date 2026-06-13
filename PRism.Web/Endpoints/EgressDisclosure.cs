using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

/// <summary>Egress-disclosure content owned by the disclosure endpoint (spec §5) — NOT added to the
/// provider descriptor. Truthful to exactly what ClaudeCodeSummarizer and ClaudeCodeFileFocusRanker send.</summary>
internal static class EgressDisclosure
{
    public const string CurrentVersion = AiDisclosure.CurrentVersion;
    public const string Recipient = "Anthropic, via the Claude Code CLI";
    public static readonly IReadOnlyList<string> DataCategories = new[]
    {
        "Pull request diff (changed files and their contents)",
        "Title",
        "Description",
    };
}
