using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct) => Task.FromResult<PrSummary?>(null);
}
