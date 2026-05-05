using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopInboxEnricher : IInboxEnricher
{
    public Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<InboxEnrichment?>(null);
}
