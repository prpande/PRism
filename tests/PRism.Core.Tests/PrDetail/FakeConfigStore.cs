using PRism.Core.Config;

namespace PRism.Core.Tests.PrDetail;

// Minimal IConfigStore fake. PrDetailLoader subscribes to Changed for cache invalidation
// (P2.29) and reads Current.Iterations.ClusteringDisabled for the Q5 escape hatch — that's
// all it needs.
internal sealed class FakeConfigStore : IConfigStore
{
    public AppConfig Current { get; set; } = AppConfig.Default;
    // PR-detail tests never read ConfigPath, but the interface requires it (S6 PR1).
    public string ConfigPath { get; set; } = "/fake/config.json";
    public Exception? LastLoadError => null;
    public event EventHandler<ConfigChangedEventArgs>? Changed;

    public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
    public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => Task.CompletedTask;
    public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
    public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) => Task.CompletedTask;

    public void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(Current));
}
