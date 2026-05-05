using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderFileFocusRanker : IFileFocusRanker
{
    public Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.FileFocus);
}
