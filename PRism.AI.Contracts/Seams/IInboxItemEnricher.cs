using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IInboxItemEnricher
{
    Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct);
}
