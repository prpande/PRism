namespace PRism.Core.Contracts;

public sealed record FileChange(
    string Path,
    FileChangeStatus Status,
    IReadOnlyList<DiffHunk> Hunks);

public enum FileChangeStatus
{
    Added,
    Modified,
    Deleted,
    Renamed,
}
