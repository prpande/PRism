namespace PRism.Core.Ai;

/// <summary>Stable provider identifiers. The single live provider's id, matching the literal used in
/// <c>TokenUsageRecord.ProviderId</c>. The multi-provider registry is deferred (spec §5).</summary>
public static class AiProviderIds
{
    public const string Claude = "claude-code";
}
