using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Noop;

public sealed class NoopHunkAnnotator : IHunkAnnotator
{
    public Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct)
        => Task.FromResult<IReadOnlyList<HunkAnnotation>>(Array.Empty<HunkAnnotation>());
}
