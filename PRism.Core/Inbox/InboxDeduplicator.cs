using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public sealed class InboxDeduplicator : IInboxDeduplicator
{
    // Dedupe pair: when both sections appear, the "winner" keeps the PR.
    private static readonly (string Winner, string Loser)[] Pairs =
    {
        ("review-requested", "mentioned"), // 1 wins over 4
        ("ci-failing", "authored-by-me"),  // 5 wins over 3
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
