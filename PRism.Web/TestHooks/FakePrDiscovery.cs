using PRism.Core;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

// Test-only IPrDiscovery (ADR-S5-1 split). Surfaces one inbox section containing the
// canonical scenario PR; TryParsePrUrl is a no-op. Delegates state reads to the shared
// FakeReviewBackingStore.
internal sealed class FakePrDiscovery : IPrDiscovery
{
    private readonly FakeReviewBackingStore _store;

    public FakePrDiscovery(FakeReviewBackingStore store)
    {
        ArgumentNullException.ThrowIfNull(store);
        _store = store;
    }

    public Task<InboxSection[]> GetInboxAsync(CancellationToken ct)
    {
        // One section with the canonical scenario PR so the inbox page renders a clickable
        // row pointing at /pr/acme/api/123.
        lock (_store.Gate)
        {
            var item = new PrInboxItem(
                Reference: FakeReviewBackingStore.Scenario,
                Title: "Calc utilities",
                Author: "e2e-user",
                Repo: "acme/api",
                UpdatedAt: _store.Now,
                PushedAt: _store.Now,
                IterationNumber: _store.Iterations.Count,
                CommentCount: 0,
                Additions: 8,
                Deletions: 0,
                HeadSha: _store.CurrentHeadSha,
                Ci: CiStatus.None,
                LastViewedHeadSha: null,
                LastSeenCommentId: null);
            var section = new InboxSection("review-requested", "Review requested", new[] { item });
            return Task.FromResult(new[] { section });
        }
    }

    public bool TryParsePrUrl(string url, out PrReference? reference)
    {
        reference = null;
        return false;
    }
}
