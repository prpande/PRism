using System;
using System.Collections.Generic;
using PRism.Core.Config;

namespace PRism.Core.Ai;

/// <summary>
/// Tri-state, per-feature seam selector. Off → Noop; Preview → Placeholder (unless the feature is
/// user-disabled, then Noop — no sample); Live → the real impl IFF one is registered for T AND consent
/// is recorded for the active provider AND the feature is user-enabled, otherwise Noop. The selector
/// does NOT probe the provider (KTD-1): provider unreachability surfaces as a call-time exception → 503.
/// </summary>
public sealed class AiSeamSelector : IAiSeamSelector
{
    private readonly AiModeState _state;
    private readonly IReadOnlyDictionary<Type, object> _noop;
    private readonly IReadOnlyDictionary<Type, object> _placeholder;
    private readonly IReadOnlyDictionary<Type, object> _real;
    private readonly AiConsentState _consent;
    private readonly AiFeatureState _features;

    public AiSeamSelector(
        AiModeState state,
        IReadOnlyDictionary<Type, object> noop,
        IReadOnlyDictionary<Type, object> placeholder,
        IReadOnlyDictionary<Type, object> real,
        AiConsentState consent,
        AiFeatureState features)
    {
        _state = state;
        _noop = noop;
        _placeholder = placeholder;
        _real = real;
        _consent = consent;
        _features = features;
    }

    public T Resolve<T>() where T : class
    {
        var featureKey = AiSeamFeatureKeys.ForSeam(typeof(T));
        var featureOn = featureKey is null || _features.IsEnabled(featureKey);

        var bag = _state.Mode switch
        {
            AiMode.Off => _noop,
            AiMode.Preview => featureOn ? _placeholder : _noop,
            AiMode.Live => featureOn
                           && _real.ContainsKey(typeof(T))
                           && _consent.IsConsented(AiProviderIds.Claude, AiDisclosure.CurrentVersion)
                ? _real : _noop,
            _ => _noop, // unknown/corrupt AiMode → safe Noop, never throw
        };
        if (!bag.TryGetValue(typeof(T), out var impl))
            throw new InvalidOperationException(
                $"AI seam {typeof(T).Name} is not registered for AI mode {_state.Mode}.");
        return (T)impl;
    }
}
