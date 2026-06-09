using System.Collections.Frozen;

namespace PRism.Core.Config;

/// <summary>Per-feature user-enablement (spec §5.1). Keyed by the nine AiCapabilities field
/// names (camelCase wire form). Persisted at <c>ui.ai.features</c>. Default: every feature on.</summary>
public sealed record AiFeaturesConfig(IReadOnlyDictionary<string, bool> Enabled)
{
    /// <summary>Shared all-features-on singleton. Backed by a <see cref="FrozenDictionary{TKey,TValue}"/>
    /// so callers cannot mutate it via a cast to <see cref="IDictionary{TKey,TValue}"/>.</summary>
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
    }.ToFrozenDictionary(StringComparer.Ordinal));
}
