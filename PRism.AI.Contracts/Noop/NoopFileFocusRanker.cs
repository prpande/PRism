using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopFileFocusRanker : IFileFocusRanker
{
    public Task<FileFocusResult> RankAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(new FileFocusResult(Array.Empty<FileFocus>(), Fallback: false));
}
