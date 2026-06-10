using PRism.Core.Inbox;

namespace PRism.Web.TestHooks;

// Test-only IPrEnricher — passthrough, never hits GitHub (the real enricher would 401/404
// on the fake scenario PR and throw, killing RefreshAsync).
internal sealed class FakePrEnricher : IPrEnricher
{
    public Task<IReadOnlyList<RawPrInboxItem>> EnrichAsync(IReadOnlyList<RawPrInboxItem> items, CancellationToken ct)
        => Task.FromResult(items);
}
