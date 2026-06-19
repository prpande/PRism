namespace PRism.AI.Contracts.Capabilities;

// AllOff / AllOn removed — capabilities are computed per-flag by AiCapabilityResolver.
public sealed record AiCapabilities(
    bool Summary,
    bool FileFocus,
    bool HunkAnnotations,
    bool PreSubmitValidators,
    bool ComposerAssist,
    bool DraftSuggestions,
    bool DraftReconciliation,
    bool InboxEnrichment,
    bool InboxRanking);
