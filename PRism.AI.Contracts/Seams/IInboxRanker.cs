using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IInboxRanker
{
    Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct);
}
