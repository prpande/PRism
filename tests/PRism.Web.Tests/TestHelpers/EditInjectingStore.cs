using PRism.Core.State;

namespace PRism.Web.Tests.TestHelpers;

// Transparent IAppStateStore decorator used to prove #605 item B (the posting paths re-read the
// draft body inside the submit lock immediately before the GitHub call). By default it is a pure
// passthrough. When ArmAfterNextLoad is set, the supplied one-shot action runs exactly once, right
// AFTER the next LoadAsync returns — simulating a concurrent PUT /draft edit that lands between the
// endpoint's pre-lock discrimination load and its body re-read. Only LoadAsync participates in the
// one-shot; UpdateAsync / SaveAsync delegate straight through so the injected edit itself does not
// re-trigger the hook.
internal sealed class EditInjectingStore : IAppStateStore
{
    private readonly IAppStateStore _inner;
    private Func<Task>? _afterNextLoad;

    public EditInjectingStore(IAppStateStore inner) => _inner = inner;

    public void ArmAfterNextLoad(Func<Task> action) => _afterNextLoad = action;

    public bool IsReadOnlyMode => _inner.IsReadOnlyMode;

    public async Task<AppState> LoadAsync(CancellationToken ct)
    {
        var result = await _inner.LoadAsync(ct).ConfigureAwait(false);
        var oneShot = Interlocked.Exchange(ref _afterNextLoad, null);
        if (oneShot is not null) await oneShot().ConfigureAwait(false);
        return result;
    }

    public Task SaveAsync(AppState state, CancellationToken ct) => _inner.SaveAsync(state, ct);

    public Task UpdateAsync(Func<AppState, AppState> transform, CancellationToken ct) =>
        _inner.UpdateAsync(transform, ct);

    public Task ResetToDefaultAsync(CancellationToken ct) => _inner.ResetToDefaultAsync(ct);
}
