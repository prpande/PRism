using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.Logging;
using PRism.AI.Contracts.Observability;

namespace PRism.Web.Ai;

/// <summary>Appends one JSON line per <see cref="AiInteractionRecord"/> to a dedicated
/// <c>ai-interactions.log</c> in the logs directory. Metadata only — the prompt (which carries the PR
/// diff) and the model's response are never written, only sizes and token/cost figures. Writes are
/// serialized by a lock and are NON-FATAL: any IO/serialization failure is swallowed (logged at most)
/// so the audit sink can never break a summary that was already computed and egressed (mirrors the
/// token-tracker spec §9 non-fatal principle). The logs directory is created lazily on first write,
/// so a sink that is never invoked litters nothing.</summary>
internal sealed partial class JsonlAiInteractionLog : IAiInteractionLog
{
    private static readonly JsonSerializerOptions Json = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly string _filePath;
    private readonly TimeProvider _clock;
    private readonly ILogger<JsonlAiInteractionLog> _logger;
    private readonly object _gate = new();

    public JsonlAiInteractionLog(string logsDirectory, TimeProvider clock, ILogger<JsonlAiInteractionLog> logger)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(logsDirectory);
        _filePath = Path.Combine(logsDirectory, "ai-interactions.log");
        _clock = clock;
        _logger = logger;
    }

    public void Record(AiInteractionRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
#pragma warning disable CA1031 // deliberate broad catch: an audit-log write must never deny the user a summary (spec §9). Cancellation is excluded so request aborts still propagate.
        try
        {
            var line = JsonSerializer.Serialize(
                new
                {
                    timestamp = _clock.GetUtcNow().ToString("O"),
                    record.Component,
                    record.ProviderId,
                    record.Model,
                    record.PrRef,
                    record.HeadSha,
                    record.Outcome,
                    record.Egressed,
                    record.LatencyMs,
                    record.InputTokens,
                    record.OutputTokens,
                    record.CacheReadInputTokens,
                    record.EstimatedCostUsd,
                    record.PromptChars,
                    record.ResponseChars,
                    record.ErrorType,
                },
                Json);

            lock (_gate)
            {
                // Lazy + idempotent: only materialize the logs dir when something is actually logged.
                Directory.CreateDirectory(Path.GetDirectoryName(_filePath)!);
                File.AppendAllText(_filePath, line + Environment.NewLine);
            }
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            Log.WriteFailed(_logger, ex);
        }
#pragma warning restore CA1031
    }

    private static partial class Log
    {
        [LoggerMessage(Level = LogLevel.Warning,
            Message = "ai-interaction-log: failed to append audit record; AI call itself is unaffected (non-fatal)")]
        internal static partial void WriteFailed(ILogger logger, Exception ex);
    }
}
