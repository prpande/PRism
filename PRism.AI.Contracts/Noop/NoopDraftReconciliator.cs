using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopDraftReconciliator : IDraftReconciliator
{
    public Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftCommentInput> drafts, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftReconciliation>>(Array.Empty<DraftReconciliation>());
}
