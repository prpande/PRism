using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IComposerAssistant
{
    Task<ComposerSuggestion?> SuggestAsync(PrReference pr, string currentDraftBody, CancellationToken ct);
}
