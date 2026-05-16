using System.Collections.Concurrent;

using Microsoft.Extensions.Logging;

namespace PRism.Web.Tests.TestHelpers;

// Captures every log entry into a thread-safe list so tests can assert that a
// specific category + level + message rendered. Minimal — no scopes, no event
// IDs assertions; the caller looks at FormattedMessage for substring matches.
//
// Lives in its own file (not embedded in a single test context) so the next
// test suite that wants log capture can reuse it without copying — pre-emptive
// fix for the test-helper-duplicates-itself anti-pattern flagged in PR #55
// review.
internal sealed class ListLoggerProvider : ILoggerProvider
{
    public ConcurrentBag<LogRecord> Records { get; } = new();

    public ILogger CreateLogger(string categoryName) => new ListLogger(categoryName, Records);
    public void Dispose() { }

    public sealed record LogRecord(string Category, LogLevel Level, string FormattedMessage, Exception? Exception);

    private sealed class ListLogger : ILogger
    {
        private readonly string _category;
        private readonly ConcurrentBag<LogRecord> _records;
        public ListLogger(string category, ConcurrentBag<LogRecord> records)
        {
            _category = category;
            _records = records;
        }

        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            ArgumentNullException.ThrowIfNull(formatter);
            _records.Add(new LogRecord(_category, logLevel, formatter(state, exception), exception));
        }

        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();
            public void Dispose() { }
        }
    }
}
