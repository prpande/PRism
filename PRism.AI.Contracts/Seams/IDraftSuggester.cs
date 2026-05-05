using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IDraftSuggester
{
    Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct);
}
