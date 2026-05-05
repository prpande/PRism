using PRism.AI.Contracts.Dtos;
using PRism.AI.Contracts.Seams;
using PRism.Core.Contracts;

namespace PRism.AI.Placeholder;

public sealed class PlaceholderHunkAnnotator : IHunkAnnotator
{
    public Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct)
        => Task.FromResult(PlaceholderData.HunkAnnotations);
}
