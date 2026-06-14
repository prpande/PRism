using PRism.Core.Ai;

namespace PRism.Web.Endpoints;

/// <summary>Egress-disclosure content owned by the disclosure endpoint (spec §5) — NOT added to the
/// provider descriptor. <see cref="DataCategories"/> is the UNION of data categories sent across all
/// real seams — diff (path, status, hunk bodies) from both ClaudeCodeSummarizer and
/// ClaudeCodeFileFocusRanker; Title and Description from the summarizer only (the ranker's allowlist
/// is {path, status, hunkBodies} and never sends Title/Description).</summary>
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
