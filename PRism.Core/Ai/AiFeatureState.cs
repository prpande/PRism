using PRism.Core.Config;

namespace PRism.Core.Ai;

/// <summary>Mirrors <c>ui.ai.features</c> for synchronous gate reads (spec §5.1). An unknown key
/// returns true (fail-open: the default is all-on, and a not-yet-stored feature must not be gated off).</summary>
public sealed class AiFeatureState
{
    private volatile AiFeaturesConfig _features;

    /// <summary>Initialises the holder with <paramref name="features"/>. A <see langword="null"/>
    /// argument falls back to <see cref="AiFeaturesConfig.AllOn"/>.</summary>
    public AiFeatureState(AiFeaturesConfig features) => _features = features ?? AiFeaturesConfig.AllOn;

    /// <summary>Replaces the stored feature config. A <see langword="null"/> argument resets to
    /// <see cref="AiFeaturesConfig.AllOn"/>.</summary>
    public void Set(AiFeaturesConfig features) => _features = features ?? AiFeaturesConfig.AllOn;

    /// <summary>Returns <see langword="false"/> only when <paramref name="featureKey"/> is explicitly
    /// mapped to <see langword="false"/>; unknown keys return <see langword="true"/> (fail-open).</summary>
    public bool IsEnabled(string featureKey) =>
        !_features.Enabled.TryGetValue(featureKey, out var on) || on;
}
