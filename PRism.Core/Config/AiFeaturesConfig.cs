namespace PRism.Core.Config;

/// <summary>Per-feature user-enablement (spec §5.1). Keyed by the nine AiCapabilities field
/// names (camelCase wire form). Persisted at <c>ui.ai.features</c>. Default: every feature on.</summary>
public sealed record AiFeaturesConfig(IReadOnlyDictionary<string, bool> Enabled)
{
    public static AiFeaturesConfig AllOn { get; } = new(new Dictionary<string, bool>(StringComparer.Ordinal)
    {
        ["summary"] = true,
        ["fileFocus"] = true,
        ["hunkAnnotations"] = true,
        ["preSubmitValidators"] = true,
        ["composerAssist"] = true,
        ["draftSuggestions"] = true,
        ["draftReconciliation"] = true,
        ["inboxEnrichment"] = true,
        ["inboxRanking"] = true,
    });
}
