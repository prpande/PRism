using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopInboxRanker : IInboxRanker
{
    public Task<IReadOnlyList<PrReference>> RankAsync(IReadOnlyList<PrReference> input, CancellationToken ct)
        => Task.FromResult(input);
}
