namespace PRism.Core.Reconciliation.Pipeline;

public interface IFileContentSource
{
    /// <summary>
    /// Returns the file content at the given SHA. The pipeline distinguishes the two
    /// "no content" outcomes:
    /// <list type="bullet">
    ///   <item><c>null</c> means "the file does not exist at this SHA" (deleted or never created)
    ///   — pipeline classifies as <see cref="StaleReason.FileDeleted"/>.</item>
    ///   <item>An empty string means "the file exists at this SHA but has zero bytes" — pipeline
    ///   runs the standard matcher (which yields <see cref="StaleReason.NoMatch"/> for any
    ///   non-empty anchored content).</item>
    /// </list>
    /// </summary>
    Task<string?> GetAsync(string filePath, string sha, CancellationToken ct);

    /// <summary>
    /// Returns true iff the SHA is reachable in the PR's commit graph (i.e., still in the
    /// branch's history; not orphaned by a force-push that rewrote history). Pipeline uses
    /// this to detect when the draft's anchored SHA has been rewritten and the standard
    /// line-matching path must fall back to the whole-file scan.
    /// </summary>
    Task<bool> IsCommitReachableAsync(string sha, CancellationToken ct);
}
