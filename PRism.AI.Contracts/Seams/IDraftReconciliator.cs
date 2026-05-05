using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IDraftReconciliator
{
    Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftComment> drafts, CancellationToken ct);
}
