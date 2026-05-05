using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopFileFocusRanker : IFileFocusRanker
{
    public Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<FileFocus>>(Array.Empty<FileFocus>());
}
