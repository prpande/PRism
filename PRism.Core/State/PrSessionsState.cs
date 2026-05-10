using System.Collections.ObjectModel;

namespace PRism.Core.State;

public sealed record PrSessionsState(
    IReadOnlyDictionary<string, ReviewSessionState> Sessions)
{
    // Wrap a fresh empty dict in ReadOnlyDictionary so the singleton can't be mutated
    // via downcast. Without this, two `AppState.Default` instances share one mutable
    // backing dictionary; a test (or any code) that adds to one would globally pollute
    // every "default" Reviews state. Using ReadOnlyDictionary makes the singleton truly
    // immutable, since the wrapper does not surface Add/Remove on its surface and the
    // private inner dictionary never escapes.
    public static PrSessionsState Empty { get; } =
        new(new ReadOnlyDictionary<string, ReviewSessionState>(
            new Dictionary<string, ReviewSessionState>()));
}
