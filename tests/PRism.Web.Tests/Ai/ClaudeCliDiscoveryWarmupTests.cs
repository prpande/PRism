using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.Core.Ai;
using PRism.Core.Config;
using PRism.Web.Ai;

namespace PRism.Web.Tests.Ai;

public sealed class ClaudeCliDiscoveryWarmupTests
{
    private sealed class CountingLocator : IClaudeCliLocator
    {
        public int ResolveCount { get; private set; }
        public Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct)
        {
            ResolveCount++;
            return Task.FromResult<ClaudeCliResolution>(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));
        }
        public ClaudeCliResolution? CurrentResolved => null;
        public void InvalidateResolved() { }
    }

    // Minimal IConfigStore fake. Exposes Current, Changed, and a RaiseModeChanged(AiMode) helper
    // that fires Changed unconditionally with the given mode — modeling ConfigStore.RaiseChanged,
    // which fires on every mutation even when the mode is unchanged. That is what the
    // transition-dedup test exercises: a Live→Live re-fire must NOT re-trigger discovery.
    private sealed class FakeConfigStore : IConfigStore
    {
        public AppConfig Current { get; private set; }
        public string ConfigPath => "/fake/config.json";
        public Exception? LastLoadError => null;
        public event EventHandler<ConfigChangedEventArgs>? Changed;

        public FakeConfigStore(AiMode initialMode)
        {
            Current = AppConfig.Default with
            {
                Ui = AppConfig.Default.Ui with
                {
                    Ai = AppConfig.Default.Ui.Ai with { Mode = initialMode }
                }
            };
        }

        // Fires Changed unconditionally with the given mode — callers can pass the same mode to
        // model a "something else changed while already in Live" scenario (the dedup test).
        public void RaiseModeChanged(AiMode mode)
        {
            Current = Current with
            {
                Ui = Current.Ui with
                {
                    Ai = Current.Ui.Ai with { Mode = mode }
                }
            };
            Changed?.Invoke(this, new ConfigChangedEventArgs(Current));
        }

        public Task InitAsync(CancellationToken ct) => Task.CompletedTask;
        public Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct) => Task.CompletedTask;
        public Task SetDefaultAccountLoginAsync(string login, CancellationToken ct) => Task.CompletedTask;
        public Task RecordAiConsentAsync(string providerId, string disclosureVersion, CancellationToken ct) => Task.CompletedTask;
    }

    [Fact]
    public async Task Warms_discovery_on_start_when_mode_is_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Live);   // test double exposing Current + Changed
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);

        await warmup.StartAsync(CancellationToken.None);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        locator.ResolveCount.Should().BeGreaterThanOrEqualTo(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Does_not_warm_on_start_when_mode_is_not_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Preview);
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);

        await warmup.StartAsync(CancellationToken.None);
        await Task.Delay(50);

        locator.ResolveCount.Should().Be(0);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Warms_discovery_when_mode_transitions_to_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Preview);
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);
        await warmup.StartAsync(CancellationToken.None);

        config.RaiseModeChanged(AiMode.Live);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        locator.ResolveCount.Should().BeGreaterThanOrEqualTo(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Does_not_rewarm_on_a_config_change_that_does_not_enter_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Live);   // already Live at startup → warms once
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);
        await warmup.StartAsync(CancellationToken.None);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        // A later config save while STILL Live (consent recorded, timeout tweaked, file-watcher reload)
        // must NOT re-fire discovery: RaiseChanged fires unconditionally, but there's no not-Live→Live edge.
        config.RaiseModeChanged(AiMode.Live);
        await Task.Delay(50);

        locator.ResolveCount.Should().Be(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(10);
    }
}
