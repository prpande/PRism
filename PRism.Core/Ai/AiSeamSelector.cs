using System;
using System.Collections.Generic;

namespace PRism.Core.Ai;

/// <summary>
/// Tri-state, per-feature seam selector. For the requested seam T it resolves by the current mode:
/// Off → Noop; Preview → Placeholder; Live → the real impl IFF one is registered for T AND the
/// provider is available, otherwise Noop (truthful-by-default §4 — never Placeholder in a Live slot).
/// In P0 the real bag is empty, so Live collapses to Noop for every seam.
/// </summary>
public sealed class AiSeamSelector : IAiSeamSelector
{
    private readonly AiModeState _state;
    private readonly IReadOnlyDictionary<Type, object> _noop;
    private readonly IReadOnlyDictionary<Type, object> _placeholder;
    private readonly IReadOnlyDictionary<Type, object> _real;
    private readonly Func<bool> _liveAvailable;

    public AiSeamSelector(
        AiModeState state,
        IReadOnlyDictionary<Type, object> noop,
        IReadOnlyDictionary<Type, object> placeholder,
        IReadOnlyDictionary<Type, object> real,
        Func<bool> liveAvailable)
    {
        _state = state;
        _noop = noop;
        _placeholder = placeholder;
        _real = real;
        _liveAvailable = liveAvailable;
    }

    public T Resolve<T>() where T : class
    {
        var bag = _state.Mode switch
        {
            AiMode.Off => _noop,
            AiMode.Preview => _placeholder,
            AiMode.Live => _real.ContainsKey(typeof(T)) && _liveAvailable() ? _real : _noop,
            _ => _noop,
        };
        if (!bag.TryGetValue(typeof(T), out var impl))
            throw new InvalidOperationException(
                $"AI seam {typeof(T).Name} is not registered for AI mode {_state.Mode}.");
        return (T)impl;
    }
}
