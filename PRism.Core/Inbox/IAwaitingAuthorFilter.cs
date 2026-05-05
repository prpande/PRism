using PRism.Core.Contracts;

namespace PRism.Core.Inbox;

public interface IAwaitingAuthorFilter
{
    /// <summary>
    /// For each candidate (which came from "is:open is:pr reviewed-by:@me"),
    /// fetches pulls/{n}/reviews and keeps only the ones with newer commits
    /// than the user's last review submission. Caches the lookup keyed on
    /// (prRef, headSha). Concurrency capped at 8.
    /// </summary>
    Task<IReadOnlyList<RawPrInboxItem>> FilterAsync(
        string viewerLogin,
        IReadOnlyList<RawPrInboxItem> candidates,
        CancellationToken ct);
}
