using Microsoft.Extensions.Logging;

namespace PRism.GitHub.Tests.TestHelpers;

/// <summary>
/// Minimal list-backed <see cref="ILogger{T}"/> for asserting which log entries the SUT
/// emitted (or did not). Captures the rendered message and level of every Log call.
/// </summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    private readonly object _gate = new();

    public List<(LogLevel Level, string Message)> Entries { get; } = new();

    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    {
        // The SUT probes candidates concurrently (Task.WhenAll up to ConcurrencyCap), so
        // guard the shared list — read Entries only after the awaited FilterAsync completes.
        lock (_gate) Entries.Add((logLevel, formatter(state, exception)));
    }
}
