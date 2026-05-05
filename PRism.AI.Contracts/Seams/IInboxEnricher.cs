using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IInboxEnricher
{
    Task<InboxEnrichment?> EnrichAsync(PrReference pr, CancellationToken ct);
}
