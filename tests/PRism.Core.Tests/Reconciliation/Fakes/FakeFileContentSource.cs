using PRism.Core.Reconciliation.Pipeline;

namespace PRism.Core.Tests.Reconciliation.Fakes;

internal sealed class FakeFileContentSource : IFileContentSource
{
    private readonly Dictionary<(string FilePath, string Sha), string> _files;
    private readonly HashSet<string> _reachableShas;

    public FakeFileContentSource(
        Dictionary<(string, string), string>? files = null,
        HashSet<string>? reachableShas = null)
    {
        _files = files ?? new();
        _reachableShas = reachableShas ?? new();
    }

    public Task<string?> GetAsync(string filePath, string sha, CancellationToken ct)
        => Task.FromResult(_files.GetValueOrDefault((filePath, sha)));

    public Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct)
        => Task.FromResult(_reachableShas.Contains(sha));
}
