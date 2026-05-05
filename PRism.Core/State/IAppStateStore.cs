namespace PRism.Core.State;

public interface IAppStateStore
{
    Task<AppState> LoadAsync(CancellationToken ct);
    Task SaveAsync(AppState state, CancellationToken ct);
}
