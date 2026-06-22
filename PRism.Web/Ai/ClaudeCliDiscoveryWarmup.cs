using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.AI.ClaudeCode;
using PRism.Core.Ai;
using PRism.Core.Config;

namespace PRism.Web.Ai;

/// <summary>
/// Eager-on-Live-entry discovery trigger (spec §7). Kicks off CLI resolution as a background task when
/// AI mode TRANSITIONS into Live (or starts Live), so the first user-facing <c>/api/capabilities</c>
/// probe never pays the ~20s worst-case discovery latency on the request path. Resolution is
/// single-flighted in the locator, so firing here and a concurrent probe never spawn two login shells.
/// </summary>
internal sealed partial class ClaudeCliDiscoveryWarmup : IHostedService
{
    private readonly IClaudeCliLocator _locator;
    private readonly IConfigStore _config;
    private readonly ILogger<ClaudeCliDiscoveryWarmup> _logger;

    // ConfigStore.RaiseChanged fires on EVERY mutation (consent, timeout, theme, a file-watcher
    // reload), not just a mode change — and the event carries no previous value. Track the last-seen
    // mode so we only warm on a not-Live -> Live TRANSITION, not on every save while already Live.
    // A benign race here (duplicate Warm) is absorbed by the locator's single-flight + memoization.
    // `volatile` because it is written on the hosting thread (StartAsync) and read/written on the
    // ConfigStore.Changed event thread — the keyword guarantees cross-thread visibility on arm64.
    private volatile AiMode _lastMode;

    public ClaudeCliDiscoveryWarmup(
        IClaudeCliLocator locator, IConfigStore config, ILogger<ClaudeCliDiscoveryWarmup> logger)
    {
        _locator = locator;
        _config = config;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _config.Changed += OnConfigChanged;
        _lastMode = _config.Current.Ui.Ai.Mode;
        if (_lastMode == AiMode.Live) Warm();   // start-as-Live warms once
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _config.Changed -= OnConfigChanged;
        return Task.CompletedTask;
    }

    private void OnConfigChanged(object? sender, ConfigChangedEventArgs e)
    {
        var mode = e.Config.Ui.Ai.Mode;
        if (mode == AiMode.Live && _lastMode != AiMode.Live) Warm();   // transition only
        _lastMode = mode;
    }

    // Fire-and-forget: discovery is off the request path and single-flighted. Log (don't rethrow) so a
    // discovery error never tears down the host but a state-dir permission/IO regression still leaves a
    // signal; the next probe re-attempts via the negative TTL.
    private void Warm() => _ = SafeResolveAsync();

    private async Task SafeResolveAsync()
    {
        try { await _locator.ResolveAsync(CancellationToken.None).ConfigureAwait(false); }
#pragma warning disable CA1031 // best-effort warmup; faults logged, never rethrown (would tear down host)
        catch (Exception ex) { Log.WarmupFaulted(_logger, ex); }
#pragma warning restore CA1031
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning, Message = "CLI discovery warmup faulted; will retry via negative TTL.")]
        internal static partial void WarmupFaulted(ILogger logger, Exception ex);
    }
}
