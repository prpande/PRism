using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopComposerAssistant : IComposerAssistant
{
    public Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct)
        => Task.FromResult<ComposerSuggestion?>(null);
}
