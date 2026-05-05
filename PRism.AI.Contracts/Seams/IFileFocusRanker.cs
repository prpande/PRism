using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IFileFocusRanker
{
    Task<IReadOnlyList<FileFocus>> RankAsync(PrReference pr, CancellationToken ct);
}
