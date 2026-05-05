namespace PRism.AI.Contracts.Capabilities;

public sealed record AiCapabilities(
    bool Summary,
    bool FileFocus,
    bool HunkAnnotations,
    bool PreSubmitValidators,
    bool ComposerAssist,
    bool DraftSuggestions,
    bool DraftReconciliation,
    bool InboxEnrichment,
    bool InboxRanking)
{
    public static AiCapabilities AllOff { get; } = new(false, false, false, false, false, false, false, false, false);
    public static AiCapabilities AllOn { get; } = new(true, true, true, true, true, true, true, true, true);
}
