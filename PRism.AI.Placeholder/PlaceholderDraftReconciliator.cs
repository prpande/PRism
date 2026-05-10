using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderDraftReconciliator : IDraftReconciliator
{
    public Task<IReadOnlyList<DraftReconciliation>> ReconcileAsync(PrReference pr, IReadOnlyList<DraftCommentInput> drafts, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<DraftReconciliation>>(
            drafts.Select(d => new DraftReconciliation(d.Id, "keep", "Anchored line is unchanged.")).ToArray());
}
