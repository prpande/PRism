using System.Text.Json;
using System.Text.Json.Serialization;

namespace PRism.AI.ClaudeCode;

/// <summary>The shape of <c>claude -p --output-format json</c> stdout (snake_case per the CLI).
/// <c>Result</c> is nullable: an envelope that omits the field deserializes to null, which the
/// provider treats as a failure rather than an empty success.</summary>
public sealed record ClaudeCliEnvelope(
    [property: JsonPropertyName("result")] string? Result,
    [property: JsonPropertyName("session_id")] string? SessionId,
    [property: JsonPropertyName("total_cost_usd")] decimal TotalCostUsd,
    [property: JsonPropertyName("usage")] ClaudeCliUsage? Usage)
{
    /// <summary>Shared options. The snake_case JSON mapping comes from the per-property
    /// <see cref="JsonPropertyName"/> attributes; <see cref="JsonSerializerDefaults.Web"/> only supplies
    /// case-insensitive property matching plus the standard web defaults.</summary>
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
}

/// <summary>Token-usage sub-object of the CLI envelope. <c>cache_creation_input_tokens</c> is the input
/// volume billed as prompt-cache WRITE — on a cold call the claude-code harness caches the bulk of the
/// prompt, so this carries almost all of the input tokens while <c>input_tokens</c> is a tiny remainder
/// (#379). The CLI also emits a <c>cache_creation.{ephemeral_1h,ephemeral_5m}</c> split and per-turn
/// <c>iterations</c>; we deliberately read only the rolled-up total here (accounting visibility, not
/// rate reconstruction — the CLI hands us <c>total_cost_usd</c> already computed).</summary>
public sealed record ClaudeCliUsage(
    [property: JsonPropertyName("input_tokens")] int InputTokens,
    [property: JsonPropertyName("output_tokens")] int OutputTokens,
    [property: JsonPropertyName("cache_read_input_tokens")] int CacheReadInputTokens,
    [property: JsonPropertyName("cache_creation_input_tokens")] int CacheCreationInputTokens);
