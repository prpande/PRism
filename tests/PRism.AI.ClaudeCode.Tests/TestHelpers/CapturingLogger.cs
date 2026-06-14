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

/// <summary>Non-generic capturing logger backing <see cref="CapturingLoggerFactory"/> — every category
/// shares one entry list so a test can assert on whatever the factory's consumer logged.</summary>
internal sealed class CapturingLogger : ILogger
{
    private readonly object _gate = new();
    public List<(LogLevel Level, string Message)> Entries { get; } = new();
    public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state,
        Exception? exception, Func<TState, Exception?, string> formatter)
    { lock (_gate) Entries.Add((logLevel, formatter(state, exception))); }
}

/// <summary>Minimal <see cref="ILoggerFactory"/> whose loggers all forward to one shared sink — lets a test
/// verify that a component which takes an <see cref="ILoggerFactory"/> (e.g. the streaming provider) actually
/// wires a real logger into what it builds, rather than swallowing logs via NullLogger.</summary>
internal sealed class CapturingLoggerFactory : ILoggerFactory
{
    private readonly CapturingLogger _logger = new();
    public List<(LogLevel Level, string Message)> Entries => _logger.Entries;
    public ILogger CreateLogger(string categoryName) => _logger;
    public void AddProvider(ILoggerProvider provider) { }
    public void Dispose() { }
}
#pragma warning restore CA1812
