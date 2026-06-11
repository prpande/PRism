using System.Collections.Concurrent;
using PRism.Core.Contracts;

namespace PRism.GitHub.Inbox;

/// <summary>
/// Per-tick cache pruning shared by the three inbox readers. Each reader holds a
/// process-lifetime cache keyed by (PrReference, T); after a tick we drop every key
/// whose PrReference is absent from the current snapshot so the map stays bounded by
/// live inbox size. The second key component (head SHA / UpdatedAt) is irrelevant to
/// eviction — a PR leaving the inbox removes all of its keys regardless. (#322)
/// </summary>
internal static class InboxCacheEviction
{
    public static void PruneAbsent<TKey2, TValue>(
        ConcurrentDictionary<(PrReference, TKey2), TValue> cache,
        IReadOnlyCollection<PrReference> live)
    {
        var liveSet = live as HashSet<PrReference> ?? new HashSet<PrReference>(live);
        foreach (var key in cache.Keys)
        {
            if (!liveSet.Contains(key.Item1))
                cache.TryRemove(key, out _);
        }
    }
}
