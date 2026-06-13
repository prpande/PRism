using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopPrSummarizer : IPrSummarizer
{
    public Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct) => Task.FromResult<PrSummary?>(null);
    // Off mode has nothing to evict/recompute — regenerate is identical to summarize (no spend).
    public Task<PrSummary?> RegenerateAsync(PrReference pr, CancellationToken ct) => SummarizeAsync(pr, ct);
}
