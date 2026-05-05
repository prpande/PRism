using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<PrSummary?>(new PrSummary(PlaceholderData.SummaryBody, PlaceholderData.SummaryCategory));
}
