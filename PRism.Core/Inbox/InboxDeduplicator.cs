using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed class InboxDeduplicator : IInboxDeduplicator
{
    // Dedupe pair: when both sections appear, the "winner" keeps the PR. Winners are never
    // filtered, only losers — so a section that is always a winner (authored-by-me) is stable
    // regardless of pair order.
    private static readonly (string Winner, string Loser)[] Pairs =
    {
        // A PR you authored is yours: it surfaces only under authored-by-me, never also under
        // any other open section. The genuine overlap is authored ∩ mentioned (you get
        // @-mentioned on your own PR); the other two are defensive against GitHub search quirks.
        ("authored-by-me", "review-requested"),
        ("authored-by-me", "awaiting-author"),
        ("authored-by-me", "mentioned"),
        ("review-requested", "mentioned"), // review-requested wins over mentioned
    };

    public IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> Deduplicate(
        IReadOnlyDictionary<string, IReadOnlyList<PrInboxItem>> sectionsById,
        bool deduplicate)
    {
        ArgumentNullException.ThrowIfNull(sectionsById);
        if (!deduplicate || sectionsById.Count == 0)
            return sectionsById;

        var result = sectionsById.ToDictionary(
            kv => kv.Key,
            kv => (IReadOnlyList<PrInboxItem>)kv.Value.ToList());

        foreach (var (winner, loser) in Pairs)
        {
            if (!result.ContainsKey(winner) || !result.ContainsKey(loser)) continue;
            var winnerRefs = new HashSet<PrReference>(result[winner].Select(p => p.Reference));
            result[loser] = result[loser].Where(p => !winnerRefs.Contains(p.Reference)).ToList();
        }
        return result;
    }
}
