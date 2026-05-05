namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }
    Exception? LastLoadError { get; }
    Task InitAsync(CancellationToken ct);
    Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct);
    event EventHandler<ConfigChangedEventArgs>? Changed;
}

public sealed class ConfigChangedEventArgs : EventArgs
{
    public ConfigChangedEventArgs(AppConfig config)
    {
        Config = config;
    }

    public AppConfig Config { get; }
}
