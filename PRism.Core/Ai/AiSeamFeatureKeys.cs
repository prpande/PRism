using PRism.AI.Contracts.Seams;

namespace PRism.Core.Ai;

/// <summary>Maps an AI seam interface to its per-feature key (the camelCase AiCapabilities field name).
/// The reverse of the seam↔flag correspondence in <see cref="AiCapabilityResolver"/>; the per-feature
/// gate (spec §5.1) uses it to resolve <c>typeof(T)</c> → feature key inside the selector/resolver.</summary>
public static class AiSeamFeatureKeys
{
    private static readonly Dictionary<Type, string> _map = new Dictionary<Type, string>
    {
        [typeof(IPrSummarizer)] = "summary",
        [typeof(IFileFocusRanker)] = "fileFocus",
        [typeof(IHunkAnnotator)] = "hunkAnnotations",
        [typeof(IPreSubmitValidator)] = "preSubmitValidators",
        [typeof(IComposerAssistant)] = "composerAssist",
        [typeof(IDraftSuggester)] = "draftSuggestions",
        [typeof(IDraftReconciliator)] = "draftReconciliation",
        [typeof(IInboxItemEnricher)] = "inboxEnrichment",
        [typeof(IInboxRanker)] = "inboxRanking",
    };

    /// <summary>The feature key for a seam type, or null if the seam is not gated by a feature flag.</summary>
    public static string? ForSeam(Type seam) => _map.TryGetValue(seam, out var key) ? key : null;
}
