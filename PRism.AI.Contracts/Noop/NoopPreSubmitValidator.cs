using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopPreSubmitValidator : IPreSubmitValidator
{
    public Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct)
        => Task.FromResult(new ValidatorReport(Array.Empty<ValidatorFinding>()));
}
