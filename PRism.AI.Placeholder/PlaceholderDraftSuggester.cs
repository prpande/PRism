using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftSuggester : IDraftSuggester
{
    public Task<IReadOnlyList<DraftSuggestion>> SuggestAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftSuggestion>>(new[]
        {
            new DraftSuggestion("services/leases/LeaseRenewalProcessor.cs", 142, "Worth a comment on the retry budget here?"),
        });
}
