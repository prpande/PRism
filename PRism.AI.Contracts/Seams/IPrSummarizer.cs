using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IPrSummarizer
{
    Task<PrSummary?> SummarizeAsync(PrReference pr, CancellationToken ct);
}
