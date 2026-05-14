using PRism.Core.State;

namespace PRism.Core.Tests.Submit.Pipeline.Fakes;

// Test-only IAppStateStore for the SubmitPipeline unit tests. The pipeline takes IAppStateStore by
// constructor (revision R1) and persists each ThreadId / ReplyCommentId stamp as an overlay
// UpdateAsync on the current session — so the pipeline tests assert against this store's persisted
// state after SubmitAsync, rather than a captured callback list. Single-threaded; no locking needed
// (the production AppStateStore's _gate serialization is exercised by its own tests).
internal sealed class InMemoryAppStateStore : IAppStateStore
{
    private AppState _state;

    public InMemoryAppStateStore(AppState? initial = null) => _state = initial ?? AppState.Default;

    public bool IsReadOnlyMode => false;

    public Task<AppState> LoadAsync(CancellationToken ct) => Task.FromResult(_state);

    public Task SaveAsync(AppState state, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(state);
        _state = state;
        return Task.CompletedTask;
    }

    public Task UpdateAsync(Func<AppState, AppState> transform, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(transform);
        _state = transform(_state);
        return Task.CompletedTask;
    }

    public Task ResetToDefaultAsync(CancellationToken ct)
    {
        _state = AppState.Default;
        return Task.CompletedTask;
    }

    // --- Test helpers ---

    public AppState Current => _state;

    public ReviewSessionState? Session(string sessionKey)
        => _state.Reviews.Sessions.TryGetValue(sessionKey, out var s) ? s : null;

    public void SeedSession(string sessionKey, ReviewSessionState session)
        => _state = _state.WithDefaultReviews(_state.Reviews with
        {
            Sessions = new Dictionary<string, ReviewSessionState>(_state.Reviews.Sessions, StringComparer.Ordinal)
            {
                [sessionKey] = session,
            },
        });
}
