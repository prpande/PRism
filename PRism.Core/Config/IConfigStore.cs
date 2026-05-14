namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }
    Exception? LastLoadError { get; }
    Task InitAsync(CancellationToken ct);
    Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct);

    /// <summary>
    /// Sets <c>github.accounts[0].login</c> for the v1 default account. In v1 the only call
    /// site is <see cref="PRism.Core.Auth.ViewerLoginHydrator"/>, which fires once on host
    /// startup after <see cref="PRism.Core.IReviewAuth.ValidateCredentialsAsync"/> succeeds
    /// against a stored token; the connect endpoints in <c>AuthEndpoints.cs</c> update only
    /// the in-memory <c>IViewerLoginProvider</c> and do NOT call this method (the on-disk
    /// login lags by one launch on first connect, then re-hydrates via the next startup
    /// validation). v2 generalizes this to per-account when the interface gains an
    /// account-key parameter and the connect endpoints adopt it directly.
    /// </summary>
    Task SetDefaultAccountLoginAsync(string login, CancellationToken ct);

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
