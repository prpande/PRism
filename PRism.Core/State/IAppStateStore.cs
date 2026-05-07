namespace PRism.Core.State;

public interface IAppStateStore
{
    Task<AppState> LoadAsync(CancellationToken ct);
    Task SaveAsync(AppState state, CancellationToken ct);

    /// <summary>
    /// Setup-only recovery path. Bypasses <see cref="SaveAsync"/>'s read-only-mode
    /// guard, deletes <c>state.json</c>, and clears the read-only flag. The caller
    /// is responsible for triggering a process restart so the next launch loads
    /// <see cref="AppState.Default"/>.
    /// </summary>
    /// <exception cref="StateResetFailedException">
    /// Thrown when <c>state.json</c> cannot be deleted. Surface a recovery dialog
    /// to the user; do not retry silently.
    /// </exception>
    Task ResetToDefaultAsync(CancellationToken ct);
}
