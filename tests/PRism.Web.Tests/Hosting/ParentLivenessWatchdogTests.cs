using Microsoft.Extensions.Hosting;
using PRism.Core.Hosting;
using PRism.Web.Hosting;

namespace PRism.Web.Tests.Hosting;

public class ParentLivenessWatchdogTests
{
    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        public bool Stopped { get; private set; }
        public CancellationToken ApplicationStarted => default;
        public CancellationToken ApplicationStopping => default;
        public CancellationToken ApplicationStopped => default;
        public void StopApplication() => Stopped = true;
    }

    [Fact]
    public async Task Watchdog_WhenParentDies_StopsApplication()
    {
        var alive = true;
        var probe = new StubProbe(() => alive);
        var lifetime = new FakeLifetime();
        var watchdog = new ParentLivenessWatchdog(probe, lifetime, pollInterval: TimeSpan.FromMilliseconds(10));

        await watchdog.StartAsync(CancellationToken.None);
        alive = false;

        // Poll the observable condition with a generous ceiling (no fixed sleep — CI-safe).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!lifetime.Stopped && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        await watchdog.StopAsync(CancellationToken.None);
        Assert.True(lifetime.Stopped);
    }

    [Fact]
    public async Task Watchdog_WhenParentStaysAlive_DoesNotStop()
    {
        var probe = new StubProbe(() => true);
        var lifetime = new FakeLifetime();
        var watchdog = new ParentLivenessWatchdog(probe, lifetime, pollInterval: TimeSpan.FromMilliseconds(10));

        await watchdog.StartAsync(CancellationToken.None);
        var deadline = DateTime.UtcNow.AddMilliseconds(200);
        while (DateTime.UtcNow < deadline) await Task.Delay(10);
        await watchdog.StopAsync(CancellationToken.None);

        Assert.False(lifetime.Stopped);
    }

    private sealed class StubProbe : IParentLivenessProbe
    {
        private readonly Func<bool> _alive;
        public StubProbe(Func<bool> alive) => _alive = alive;
        public bool IsParentAlive() => _alive();
    }
}
