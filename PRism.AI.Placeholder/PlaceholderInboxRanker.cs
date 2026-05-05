using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderInboxRanker : IInboxRanker
{
    public Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<PrReference>>(input.OrderByDescending(p => p.Number).ToArray());
}
