namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }
    Exception? LastLoadError { get; }
    Task InitAsync(CancellationToken ct);
    Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct);

    /// <summary>
    /// Sets <c>github.accounts[0].login</c> for the v1 default account. The login is
    /// populated by <see cref="PRism.Core.Auth.ViewerLoginHydrator"/> the first time
    /// <see cref="PRism.Core.IReviewAuth.ValidateCredentialsAsync"/> succeeds after Setup,
    /// and by the connect endpoints during the auth dance. v2 generalizes this to per-account
    /// when the interface gains an account-key parameter.
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
