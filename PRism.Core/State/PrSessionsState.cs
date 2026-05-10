namespace PRism.Core.State;

public sealed record PrSessionsState(
    IReadOnlyDictionary<string, ReviewSessionState> Sessions)
{
    public static PrSessionsState Empty { get; } =
        new(new Dictionary<string, ReviewSessionState>());
}
