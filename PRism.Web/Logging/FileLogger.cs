using System;
using System.Collections.Generic;
using System.Threading;

using Microsoft.Extensions.Logging;

namespace PRism.Web.Logging;

internal sealed class FileLogger : ILogger
{
    private readonly string _category;
    private readonly FileLoggerProvider _parent;

    public FileLogger(string category, FileLoggerProvider parent)
    {
        _category = category;
        _parent = parent;
    }

    public IDisposable BeginScope<TState>(TState state) where TState : notnull => NullScope.Instance;

    public bool IsEnabled(LogLevel logLevel) => true;

    public void Log<TState>(
        LogLevel logLevel,
        EventId eventId,
        TState state,
        Exception? exception,
        Func<TState, Exception?, string> formatter)
    {
        ArgumentNullException.ThrowIfNull(formatter);

        string formatted;
        if (state is IReadOnlyList<KeyValuePair<string, object?>> kvList)
        {
            string? template = null;
            var scrubbed = new Dictionary<string, object?>();
            foreach (var kv in kvList)
            {
                if (string.Equals(kv.Key, "{OriginalFormat}", StringComparison.Ordinal))
                    template = kv.Value as string;
                else
                    scrubbed[kv.Key] = SensitiveFieldScrubber.ScrubFieldName(kv.Key, kv.Value);
            }

            if (template != null)
            {
                // Spec § 7: catch template-substitution failures, fall back to the unscrubbed
                // formatter, increment the parser-failure counter, log to stderr once per session.
                // LogTemplateFormatter itself catches Exception broadly and returns the template
                // verbatim, but we wrap the call anyway as defense-in-depth: a buggy refactor
                // that narrows the formatter's catch shouldn't crash the request thread.
                try
                {
                    formatted = LogTemplateFormatter.Format(template, scrubbed);
                }
#pragma warning disable CA1031 // Broad catch is the spec contract for this seam.
                catch (Exception)
#pragma warning restore CA1031
                {
                    formatted = formatter(state, exception);
                    _parent.OnTemplateSubstitutionFailure();
                }
            }
            else
            {
                formatted = formatter(state, exception);
            }
        }
        else
        {
            formatted = formatter(state, exception);
        }

        var evt = new FileLogEvent(
            _parent.Now(),
            logLevel,
            _category,
            eventId,
            formatted,
            exception?.ToString());

        _parent.TryEnqueue(evt);
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();
        public void Dispose() { }
    }
}
