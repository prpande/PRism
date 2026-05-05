namespace PRism.Core.Ai;

public sealed class AiSeamSelector : IAiSeamSelector
{
    private readonly AiPreviewState _state;
    private readonly IReadOnlyDictionary<Type, object> _noop;
    private readonly IReadOnlyDictionary<Type, object> _placeholder;

    public AiSeamSelector(
        AiPreviewState state,
        IReadOnlyDictionary<Type, object> noopImpls,
        IReadOnlyDictionary<Type, object> placeholderImpls)
    {
        _state = state;
        _noop = noopImpls;
        _placeholder = placeholderImpls;
    }

    public T Resolve<T>() where T : class
    {
        var bag = _state.IsOn ? _placeholder : _noop;
        if (!bag.TryGetValue(typeof(T), out var impl))
            throw new InvalidOperationException($"AI seam {typeof(T).Name} is not registered for ai-preview {(_state.IsOn ? "on" : "off")} mode.");
        return (T)impl;
    }
}
