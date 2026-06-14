using Microsoft.Extensions.Logging;

namespace PRism.AI.ClaudeCode.Tests.TestHelpers;

#pragma warning disable CA1812 // Instantiated by later tasks' tests; no consumer exists at wiring time.
/// <summary>Minimal list-backed <see cref="ILogger{T}"/> for asserting emitted log entries.</summary>
internal sealed class CapturingLogger<T> : ILogger<T>
{
    private readonly object _gate = new();
    public List<(LogLevel Level, string Message)> Entries { get; } = new();
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    { lock (_gate) Entries.Add((logLevel, formatter(state, exception))); }
}
#pragma warning restore CA1812
