using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftSuggestion>>(Array.Empty<DraftSuggestion>());
}
