using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

internal sealed class ActivePrCache : IActivePrCache
{
    private readonly ActivePrSubscriberRegistry _subscribers;

    // PrReference is a record (verified at PRism.Core.Contracts/PrReference.cs) so
    // value equality drives the ConcurrentDictionary lookup correctly — two PrReference
    // instances with the same (Owner, Repo, Number) hash and compare equal.
    private readonly ConcurrentDictionary<PrReference, ActivePrSnapshot> _snapshots = new();

    public ActivePrCache(ActivePrSubscriberRegistry subscribers)
    {
        ArgumentNullException.ThrowIfNull(subscribers);
        _subscribers = subscribers;
    }

    public bool IsSubscribed(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        return _subscribers.AnySubscribers(prRef);
    }

    public ActivePrSnapshot? GetCurrent(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        return _snapshots.TryGetValue(prRef, out var snap) ? snap : null;
    }

    public void Update(PrReference prRef, ActivePrSnapshot snapshot)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        ArgumentNullException.ThrowIfNull(snapshot);
        _snapshots[prRef] = snapshot;
    }
}
