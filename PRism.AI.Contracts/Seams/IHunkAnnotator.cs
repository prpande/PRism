using PRism.AI.Contracts.Dtos;
using PRism.Core.Contracts;

namespace PRism.AI.Contracts.Seams;

public interface IHunkAnnotator
{
    Task<IReadOnlyList<HunkAnnotation>> AnnotateAsync(PrReference pr, string filePath, int hunkIndex, CancellationToken ct);
}
