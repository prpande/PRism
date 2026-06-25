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

    public void Clear() => _snapshots.Clear();

    public void Retain(IReadOnlyCollection<PrReference> live)
    {
        ArgumentNullException.ThrowIfNull(live);
        // Reuse the caller's set when it already is one (the poller passes the same HashSet it
        // built for the _state prune) to avoid a second allocation; otherwise build one for O(1)
        // membership. _snapshots.Keys is a snapshot, so removing during iteration is safe.
        var keep = live as ISet<PrReference> ?? new HashSet<PrReference>(live);
        foreach (var key in _snapshots.Keys)
        {
            if (!keep.Contains(key)) _snapshots.TryRemove(key, out _);
        }
    }
}
