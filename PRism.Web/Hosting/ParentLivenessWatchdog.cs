using Microsoft.Extensions.Hosting;
using PRism.Core.Hosting;

namespace PRism.Web.Hosting;

/// <summary>
/// Polls a parent-liveness probe; when the launching Electron shell disappears
/// (graceful quit kills us first; this is the ungraceful-crash fallback), stops
/// the host so the sidecar never orphans. Only registered in sidecar mode.
/// Never restarts the app — self-exit only.
/// </summary>
internal sealed class ParentLivenessWatchdog : BackgroundService
{
    private readonly IParentLivenessProbe _probe;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly TimeSpan _pollInterval;

    public ParentLivenessWatchdog(
        IParentLivenessProbe probe,
        IHostApplicationLifetime lifetime,
        TimeSpan pollInterval)
    {
        _probe = probe;
        _lifetime = lifetime;
        _pollInterval = pollInterval;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!_probe.IsParentAlive())
            {
                _lifetime.StopApplication();
                return;
            }

            try { await Task.Delay(_pollInterval, stoppingToken).ConfigureAwait(false); }
            catch (TaskCanceledException) { return; }
        }
    }
}
