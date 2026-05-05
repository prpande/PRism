using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopInboxItemEnricher : IInboxItemEnricher
{
    public Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<InboxItemEnrichment>>(Array.Empty<InboxItemEnrichment>());
}
