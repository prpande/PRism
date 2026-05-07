using PRism.Core.Config;

namespace PRism.Core.Tests.PrDetail;

// Minimal IConfigStore fake. PrDetailLoader subscribes to Changed for cache invalidation
// (P2.29) and reads Current.Iterations.ClusteringDisabled for the Q5 escape hatch — that's
// all it needs.
internal sealed class FakeConfigStore : IConfigStore
{
    public AppConfig Current { get; set; } = AppConfig.Default;
    public Exception? LastLoadError => null;
    public event EventHandler<ConfigChangedEventArgs>? Changed;

    public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => Task.CompletedTask;

    public void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(Current));
}
