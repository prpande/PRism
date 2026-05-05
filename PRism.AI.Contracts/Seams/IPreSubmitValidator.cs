using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IPreSubmitValidator
{
    Task<ValidatorReport> ValidateAsync(PrReference pr, CancellationToken ct);
}
