using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.DraftSuggestions);
}
