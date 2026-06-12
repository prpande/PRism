using Microsoft.Extensions.Logging;

namespace PRism.Web.Tests.TestHelpers;

/// <summary>
/// Captures the structured key/value arguments of <c>[LoggerMessage]</c> source-generated
/// logs (the <c>{OriginalFormat}</c> template entry is dropped). Auth-logging tests assert on
/// the emitted field KEYS — the names <c>SensitiveFieldScrubber</c> sees — rather than the
/// formatted message text that <see cref="ListLoggerProvider"/> captures.
/// </summary>
internal sealed class KvCapturingLoggerProvider : ILoggerProvider
{
    public List<KvRecord> Records { get; } = new();
    public ILogger CreateLogger(string categoryName) => new KvLogger(categoryName, Records);
    public void Dispose() { }

    public sealed record KvRecord(string Category, IReadOnlyDictionary<string, object?> Args)
    {
        public IEnumerable<string> Keys => Args.Keys;
        public object? GetValue(string key) => Args.TryGetValue(key, out var v) ? v : null;
    }

    private sealed class KvLogger : ILogger
    {
        private readonly string _category;
        private readonly List<KvRecord> _records;
        public KvLogger(string category, List<KvRecord> records) { _category = category; _records = records; }
        public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;
        public bool IsEnabled(LogLevel logLevel) => true;
        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            if (state is IReadOnlyList<KeyValuePair<string, object?>> kvList)
            {
                var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (var kv in kvList)
                    if (!string.Equals(kv.Key, "{OriginalFormat}", StringComparison.Ordinal))
                        dict[kv.Key] = kv.Value;
                lock (_records) { _records.Add(new KvRecord(_category, dict)); }
            }
        }
        private sealed class NullScope : IDisposable
        {
            public static readonly NullScope Instance = new();
            public void Dispose() { }
        }
    }
}
