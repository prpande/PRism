using System;

using Microsoft.Extensions.Logging;

namespace PRism.Web.Logging;

// Pre-formatted log event passed from the request thread to the writer task. All fields are
// resolved on the request thread (template substitution, scrubbing, exception ToString) so
// the writer task does pure I/O. No TState boxing; no deferred formatter invocation.
internal readonly record struct FileLogEvent(
    DateTimeOffset Timestamp,
    LogLevel Level,
    string Category,
    EventId EventId,
    string FormattedMessage,
    string? ExceptionString);
