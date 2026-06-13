using System.Collections.Concurrent;
using Microsoft.Extensions.Logging;
using PRism.Web.Sse;

namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// Captures the formatted messages of <see cref="SseChannel"/> logs whose <see cref="EventId"/>
/// matches the one supplied at construction. Each SSE log test watches a single event
/// (4 = per-publish fanout, 5 = per-subscriber delivery); the captured text accumulates in
/// <see cref="Messages"/>.
/// </summary>
internal sealed class CapturingLogger : ILogger<SseChannel>
{
    private readonly int _eventId;
    public CapturingLogger(int eventId) => _eventId = eventId;

    public ConcurrentBag<string> Messages { get; } = new();
    public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
    public bool IsEnabled(LogLevel logLevel) => true;
    public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
    {
        ArgumentNullException.ThrowIfNull(formatter);
        if (eventId.Id == _eventId) Messages.Add(formatter(state, exception));
    }
    private sealed class NullScope : IDisposable { public static readonly NullScope Instance = new(); public void Dispose() { } }
}
