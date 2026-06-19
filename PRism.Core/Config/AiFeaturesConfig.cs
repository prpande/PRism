using System;
using System.Collections.Generic;
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

    /// <summary>Returns a new config with <paramref name="key"/> set to <paramref name="value"/>,
    /// all other keys preserved. Rebuilds the frozen dict with <see cref="StringComparer.Ordinal"/>
    /// (matching the stored comparer) so a casing drift cannot silently no-op the update.
    /// Key validity is the CALLER's gate — ConfigStore's allowlist + exact patch arms only ever
    /// pass the four settable keys. <c>With</c> deliberately does NOT reject a key absent from
    /// <see cref="Enabled"/>: a sparse persisted config must stay fail-open (a missing key reads
    /// as <c>true</c> downstream), so ADDING the key here is correct, not an error — a
    /// ContainsKey guard would wrongly reject a valid patch against a partial config.</summary>
    public AiFeaturesConfig With(string key, bool value)
    {
        var next = new Dictionary<string, bool>(Enabled, StringComparer.Ordinal) { [key] = value };
        return new AiFeaturesConfig(next.ToFrozenDictionary(StringComparer.Ordinal));
    }
}
