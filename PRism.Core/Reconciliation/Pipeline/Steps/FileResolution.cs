namespace PRism.Core.Reconciliation.Pipeline.Steps;

internal static class FileResolution
{
    public sealed record FileResolveResult(
        bool Resolved,
        string? ResolvedPath,
        StaleReason? StaleReason);

    // Caller (POST /reload handler in PR3) builds `renames` (oldPath → newPath) and
    // `deletedPaths` from the PR's file-changes list. PR2 takes them as inputs only.
    public static FileResolveResult Resolve(
        string draftFilePath,
        IReadOnlyDictionary<string, string> renames,
        IReadOnlySet<string> deletedPaths)
    {
        if (deletedPaths.Contains(draftFilePath))
            return new FileResolveResult(false, null, Reconciliation.StaleReason.FileDeleted);

        if (renames.TryGetValue(draftFilePath, out var newPath))
            return new FileResolveResult(true, newPath, null);

        return new FileResolveResult(true, draftFilePath, null);
    }
}
