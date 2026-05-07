namespace PRism.Core.State;

public interface IAppStateStore
{
    /// <summary>
    /// True after <see cref="LoadAsync"/> reads a state.json with <c>version</c> greater
    /// than the binary's <c>CurrentVersion</c>. While set, <see cref="SaveAsync"/> and
    /// <see cref="UpdateAsync"/> throw <see cref="InvalidOperationException"/>; the
    /// running binary cannot safely persist a downgrade. Cleared by
    /// <see cref="ResetToDefaultAsync"/>.
    /// </summary>
    bool IsReadOnlyMode { get; }

    Task<AppState> LoadAsync(CancellationToken ct);
    Task SaveAsync(AppState state, CancellationToken ct);

    /// <summary>
    /// Atomic load → transform → save under the store's internal lock. Concurrent callers
    /// each observe prior callers' persisted writes (last-transform-wins; no torn reads,
    /// no lost writes). PR4's <c>mark-viewed</c> and <c>files/viewed</c> endpoints use
    /// this to gate two-tab races on a single PR's <c>ReviewSessionState</c>. Throws
    /// <see cref="InvalidOperationException"/> when <see cref="IsReadOnlyMode"/> is true.
    /// </summary>
    Task UpdateAsync(Func<AppState, AppState> transform, CancellationToken ct);

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
