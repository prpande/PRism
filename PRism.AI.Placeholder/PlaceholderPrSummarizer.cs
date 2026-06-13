using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<PrSummary?>(new PrSummary(PlaceholderData.SummaryBody, PlaceholderData.SummaryCategory));

    // Preview mode has no cache to bypass — regenerate returns the same placeholder (no real spend).
    public Task<PrSummary?> RegenerateAsync(PrReference pr, CancellationToken ct) => SummarizeAsync(pr, ct);
}
