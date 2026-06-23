using PRism.Core.Contracts;
using PRism.Core.Inbox;

namespace PRism.Web.TestHooks;

// Test-only IPrBatchReader — echoes each item's hydration fields, never hits GitHub (the real
// reader would 401/404 on the fake scenario PR). The e2e fake section runner only ever populates
// "review-requested" (never "awaiting-author"), so ViewerLastReviewSha is immaterial here.
internal sealed class FakePrBatchReader : IPrBatchReader
{
    public Task<IReadOnlyDictionary<PrReference, BatchPrData>> ReadAsync(
        IReadOnlyList<RawPrInboxItem> items, string viewerLogin, CancellationToken ct)
        => Task.FromResult<IReadOnlyDictionary<PrReference, BatchPrData>>(
            items.ToDictionary(i => i.Reference, i => new BatchPrData(
                i.HeadSha, i.Additions, i.Deletions, i.CommitCount, i.ChangedFiles,
                i.PushedAt, i.MergedAt, i.ClosedAt, ViewerLastReviewSha: null)));
}
