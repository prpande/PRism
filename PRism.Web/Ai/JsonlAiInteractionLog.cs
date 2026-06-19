using System.Text.Json;
using System.Text.Json.Nodes;
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
    internal static readonly JsonSerializerOptions Json = new()
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
            // Serialize the record DIRECTLY rather than a hand-listed projection, so a future
            // AiInteractionRecord field can never silently drop from the audit log — that field-drop
            // bug is exactly #379 (at the provider's token parse), and a hand-maintained projection here
            // was the same trap one layer up. Safe because AiInteractionRecord is metadata-only by
            // contract (no prompt/response content). `timestamp` is clock-derived — not on the record —
            // so it is injected as the leading property after serialization. Null fields are still
            // omitted (WhenWritingNull) and the enum/camelCase options still apply via `Json`.
            var node = JsonSerializer.SerializeToNode(record, Json)!.AsObject();
            node.Insert(0, "timestamp", _clock.GetUtcNow().ToString("O"));
            // ToJsonString consumes only the JsonWriterOptions slice of `Json` (so we get the
            // non-indented single-line form); the camelCase naming policy and enum converter were
            // already applied during SerializeToNode above and are baked into `node`.
            var line = node.ToJsonString(Json);

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
