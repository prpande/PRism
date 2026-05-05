using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxItemEnricher : IInboxItemEnricher
{
    public Task<IReadOnlyList<InboxItemEnrichment>> EnrichAsync(
        IReadOnlyList<PrInboxItem> items, CancellationToken ct)
    {
        var result = items
            .Select(i => new InboxItemEnrichment(
                i.Reference.PrId,
                PlaceholderData.SummaryCategory,
                PlaceholderData.SummaryBody))
            .ToArray();
        return Task.FromResult<IReadOnlyList<InboxItemEnrichment>>(result);
    }
}
