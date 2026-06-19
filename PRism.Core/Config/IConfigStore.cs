namespace PRism.Core.Config;

public interface IConfigStore
{
    AppConfig Current { get; }

    /// <summary>
    /// Absolute path to the backing <c>config.json</c> file (= <c>Path.Combine(dataDir, "config.json")</c>
    /// for the production implementation). Surfaced by <c>GET /api/preferences</c> so the Settings
    /// page can render a copyable file path without the frontend having to know the dataDir
    /// derivation. Added in S6 PR1 (spec § 2.4).
    /// </summary>
    string ConfigPath { get; }

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

    /// <summary>
    /// Records egress-consent for a specific AI provider and disclosure version, persisting
    /// to disk at <c>ui.ai.consent</c>. Validates both arguments are non-empty; sets
    /// <c>AcknowledgedAt</c> to <see cref="DateTimeOffset.UtcNow"/>. Thread-safe via the
    /// same semaphore gate used by all other structured writes.
    /// </summary>
    Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct);

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
