using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

// Two-way concurrent map of subscriberId ↔ PrReference. Used by ActivePrPoller (which iterates
// UniquePrRefs() once per tick) and SseChannel (which uses SubscribersFor on event publish).
// ConcurrentDictionary<TKey,byte> is the standard way to spell "ConcurrentSet" in BCL.
public sealed class ActivePrSubscriberRegistry
{
    private readonly ConcurrentDictionary<string, ConcurrentDictionary<PrReference, byte>> _bySubscriber = new();
    private readonly ConcurrentDictionary<PrReference, ConcurrentDictionary<string, byte>> _byPr = new();

    public void Add(string subscriberId, PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(subscriberId);
        ArgumentNullException.ThrowIfNull(prRef);

        _bySubscriber.GetOrAdd(subscriberId, _ => new ConcurrentDictionary<PrReference, byte>())[prRef] = 0;
        _byPr.GetOrAdd(prRef, _ => new ConcurrentDictionary<string, byte>())[subscriberId] = 0;
    }

    public void Remove(string subscriberId, PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(subscriberId);
        ArgumentNullException.ThrowIfNull(prRef);

        if (_bySubscriber.TryGetValue(subscriberId, out var prs))
        {
            prs.TryRemove(prRef, out _);
            if (prs.IsEmpty) _bySubscriber.TryRemove(subscriberId, out _);
        }
        if (_byPr.TryGetValue(prRef, out var subs))
        {
            subs.TryRemove(subscriberId, out _);
            if (subs.IsEmpty) _byPr.TryRemove(prRef, out _);
        }
    }

    public void RemoveSubscriber(string subscriberId)
    {
        ArgumentNullException.ThrowIfNull(subscriberId);

        if (!_bySubscriber.TryRemove(subscriberId, out var prs)) return;
        foreach (var prRef in prs.Keys)
        {
            if (_byPr.TryGetValue(prRef, out var subs))
            {
                subs.TryRemove(subscriberId, out _);
                if (subs.IsEmpty) _byPr.TryRemove(prRef, out _);
            }
        }
    }

    public IReadOnlyCollection<PrReference> UniquePrRefs() => _byPr.Keys.ToList();

    public IReadOnlyCollection<string> SubscribersFor(PrReference prRef)
    {
        ArgumentNullException.ThrowIfNull(prRef);
        return _byPr.TryGetValue(prRef, out var subs) ? subs.Keys.ToList() : Array.Empty<string>();
    }
}
