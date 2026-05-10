namespace PRism.Core.Reconciliation.Pipeline;

public interface IFileContentSource
{
    Task<string?> GetAsync(string filePath, string sha, CancellationToken ct);
    Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct);
}
