using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxEnricher : IInboxEnricher
{
    public Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<InboxEnrichment?>(PlaceholderData.Enrichment);
}
