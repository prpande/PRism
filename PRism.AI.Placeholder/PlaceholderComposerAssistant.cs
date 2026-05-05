using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderComposerAssistant : IComposerAssistant
{
    public Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct)
        => Task.FromResult<ComposerSuggestion?>(new ComposerSuggestion(
            "Consider clarifying that this only applies to the renewal path, not the cancellation flow.",
            "neutral"));
}
