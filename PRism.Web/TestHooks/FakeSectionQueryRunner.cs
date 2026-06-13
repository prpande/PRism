using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Web.TestHooks;

// Test-only ISectionQueryRunner. Returns the canonical scenario PR in "review-requested"
// ONLY when FakeReviewBackingStore.InboxSeeded is set (via /test/seed-inbox); otherwise
// empty, so specs that don't opt in keep an empty inbox (parity baselines unchanged).
internal sealed class FakeSectionQueryRunner : ISectionQueryRunner
{
    private readonly FakeReviewBackingStore _store;

    public FakeSectionQueryRunner(FakeReviewBackingStore store)
    {
        ArgumentNullException.ThrowIfNull(store);
        _store = store;
    }

    public Task<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>> QueryAllAsync(
        IReadOnlySet<string> visibleSectionIds, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(visibleSectionIds);
        var result = new Dictionary<string, IReadOnlyList<RawPrInboxItem>>();
        lock (_store.Gate)
        {
            // Mirror the real GitHubSectionQueryRunner's 401 fallback: EVERY visible section
            // gets a key (empty unless seeded), so the unseeded rendered inbox is identical to
            // the prior real-GitHub empty state (5 section headers), not a 1-section divergence.
            foreach (var id in visibleSectionIds)
            {
                if (_store.InboxSeeded && id == "review-requested")
                {
                    var item = new RawPrInboxItem(
                        Reference: FakeReviewBackingStore.Scenario,
                        Title: "Calc utilities",
                        Author: "e2e-user",
                        Repo: "acme/api",
                        UpdatedAt: _store.Now,
                        PushedAt: _store.Now,
                        CommentCount: 0,
                        Additions: 8,
                        Deletions: 0,
                        HeadSha: _store.CurrentHeadSha,
                        CommitCount: _store.Iterations.Count);
                    result[id] = new[] { item };
                }
                else
                {
                    result[id] = Array.Empty<RawPrInboxItem>();
                }
            }
        }
        return Task.FromResult<IReadOnlyDictionary<string, IReadOnlyList<RawPrInboxItem>>>(result);
    }

    public Task<IReadOnlyList<RawPrInboxItem>> QueryClosedHistoryAsync(int windowDays, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<RawPrInboxItem>>(Array.Empty<RawPrInboxItem>());
}
