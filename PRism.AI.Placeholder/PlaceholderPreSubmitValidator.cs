using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderPreSubmitValidator : IPreSubmitValidator
{
    public Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(PlaceholderData.Validator);
}
