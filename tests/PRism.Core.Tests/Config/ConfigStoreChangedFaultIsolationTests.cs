using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using FluentAssertions;
using Microsoft.Extensions.Logging;
using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.Config;

// These tests deliberately do NOT call InitAsync, so no FileSystemWatcher is started. A live
// watcher would fire a second, debounced RaiseChanged ~100ms after each PatchAsync disk write —
// doubling the logged-fault count (test 2's ContainSingle) and racing LastLoadError (test 4).
// Starting from AppConfig.Default is a sufficient baseline for every assertion here.
// CA1030 suppressed: test method names start with "RaiseChanged_" to clearly describe the
// unit under test; this is a naming-by-convention pattern in this test class, not an event.
#pragma warning disable CA1030
public sealed class ConfigStoreChangedFaultIsolationTests
{
    [Fact]
    public async Task RaiseChanged_isolates_a_throwing_subscriber_and_still_runs_siblings_and_persists()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);

        var secondRan = false;
        store.Changed += (_, _) => throw new InvalidOperationException("subscriber boom");
        store.Changed += (_, _) => secondRan = true;

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        await act.Should().NotThrowAsync("a faulting subscriber must not propagate into the writer");
        secondRan.Should().BeTrue("a faulting subscriber must not abort dispatch to the rest");
        store.Current.Ui.Theme.Should().Be("dark", "the config write persisted despite the fault");
    }

    [Fact]
    public async Task RaiseChanged_logs_a_subscriber_fault_at_Error_with_the_event_id()
    {
        using var dir = new TempDataDir();
        var logger = new CapturingLogger();
        using var store = new ConfigStore(dir.Path, logger);

        var boom = new InvalidOperationException("subscriber boom");
        store.Changed += (_, _) => throw boom;

        await store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        logger.Entries.Should().ContainSingle(e =>
            e.Level == LogLevel.Error
            && e.EventId.Name == "ConfigStoreSubscriberFaulted"
            && e.Exception == boom);
    }

    [Fact]
    public async Task RaiseChanged_does_not_swallow_OperationCanceledException_on_the_synchronous_path()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);

        store.Changed += (_, _) => throw new OperationCanceledException();

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        await act.Should().ThrowAsync<OperationCanceledException>(
            "cooperative cancellation is not swallowed by fault isolation");
    }

    private sealed class CapturingLogger : ILogger<ConfigStore>
    {
        public List<(LogLevel Level, EventId EventId, Exception? Exception, string Message)> Entries { get; } = new();
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception,
            Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            Entries.Add((logLevel, eventId, exception, formatter(state, exception)));
        }
        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();
            public void Dispose() { }
        }
    }
}
#pragma warning restore CA1030
