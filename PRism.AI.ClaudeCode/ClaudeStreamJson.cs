using System.Text.Json;

namespace PRism.AI.ClaudeCode;

public enum StreamLineKind { Ignored, Init, TextDelta, ToolUse, Result }

/// <summary>One parsed stdout line. Only the field(s) for <see cref="Kind"/> are populated.</summary>
public sealed record ParsedLine(
    StreamLineKind Kind,
    string? SessionId = null,
    string? Text = null,
    string? ToolName = null,
    JsonElement? ToolInput = null,
    ResultLine? Result = null);

/// <summary>The terminal <c>result</c> line, mapped. <see cref="Malformed"/> = the line is a result
/// but its shape could not be mapped (drift signal; Task 8). On the error path <see cref="FullText"/>
/// is <c>.result</c> when present else <c>""</c>.</summary>
public sealed record ResultLine(
    bool IsError, string? Code, string FullText,
    int InputTokens, int OutputTokens, int CacheReadInputTokens, decimal EstimatedCostUsd,
    bool Malformed = false);

/// <summary>Pure NDJSON line parser for <c>claude</c> stream-json output (spec §4/§9). Never throws on a
/// malformed line — returns <see cref="StreamLineKind.Ignored"/> (or a <c>Malformed</c> result).</summary>
public static class ClaudeStreamJson
{
    public static ParsedLine Parse(string line)
    {
        if (string.IsNullOrWhiteSpace(line)) return new ParsedLine(StreamLineKind.Ignored);
        JsonDocument doc;
        try { doc = JsonDocument.Parse(line); }
        catch (JsonException) { return new ParsedLine(StreamLineKind.Ignored); }
        using (doc)
        {
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty("type", out var typeEl))
                return new ParsedLine(StreamLineKind.Ignored);

            switch (typeEl.GetString())
            {
                case "system":
                    return root.TryGetProperty("subtype", out var st) && st.GetString() == "init"
                        ? new ParsedLine(StreamLineKind.Init,
                            SessionId: root.TryGetProperty("session_id", out var sid) ? sid.GetString() : null)
                        : new ParsedLine(StreamLineKind.Ignored);

                case "stream_event":
                    return ParseStreamEvent(root);

                case "assistant":
                    return ParseAssistant(root);

                case "result":
                    return new ParsedLine(StreamLineKind.Result, Result: ParseResult(root));

                default:
                    return new ParsedLine(StreamLineKind.Ignored);
            }
        }
    }

    private static ParsedLine ParseStreamEvent(JsonElement root)
    {
        if (!root.TryGetProperty("event", out var ev) ||
            !ev.TryGetProperty("type", out var et) || et.GetString() != "content_block_delta" ||
            !ev.TryGetProperty("delta", out var delta) ||
            !delta.TryGetProperty("type", out var dt) || dt.GetString() != "text_delta" ||
            !delta.TryGetProperty("text", out var txt))
            return new ParsedLine(StreamLineKind.Ignored);
        return new ParsedLine(StreamLineKind.TextDelta, Text: txt.GetString());
    }

    private static ParsedLine ParseAssistant(JsonElement root)
    {
        // Source tool_use from the assistant block's first tool_use content; ignore text/thinking
        // (already delivered via text_delta — mapping them would double-count).
        if (root.TryGetProperty("message", out var msg) &&
            msg.TryGetProperty("content", out var content) && content.ValueKind == JsonValueKind.Array)
        {
            foreach (var block in content.EnumerateArray())
            {
                if (block.TryGetProperty("type", out var bt) && bt.GetString() == "tool_use")
                {
                    var name = block.TryGetProperty("name", out var n) ? n.GetString() : null;
                    JsonElement? input = block.TryGetProperty("input", out var inp) ? inp.Clone() : null;
                    return new ParsedLine(StreamLineKind.ToolUse, ToolName: name, ToolInput: input);
                }
            }
        }
        return new ParsedLine(StreamLineKind.Ignored);
    }

    private static ResultLine ParseResult(JsonElement root)
    {
        if (!root.TryGetProperty("is_error", out var isErrEl) ||
            isErrEl.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
            // A result we cannot even read is_error from -> malformed (drift).
            return new ResultLine(IsError: true, Code: null, FullText: "", 0, 0, 0, 0m, Malformed: true);

        var isError = isErrEl.GetBoolean();
        var fullText = root.TryGetProperty("result", out var r) && r.ValueKind == JsonValueKind.String
            ? r.GetString()! : "";
        var cost = root.TryGetProperty("total_cost_usd", out var c) && c.ValueKind == JsonValueKind.Number
            ? c.GetDecimal() : 0m;
        var (inTok, outTok, cacheTok) = ReadUsage(root);

        // Code precedence (documented, not incidental): a NON-"success" subtype WINS over api_error_status
        // (the subtype is the more specific error kind, e.g. error_max_turns). api_error_status is the
        // fallback ONLY when subtype is "success" or absent (the probed API-error shape: subtype:"success",
        // api_error_status:404). If NEITHER yields a code (is_error true but no usable subtype and no numeric
        // status), Code stays null — LlmTurnError still fires (is_error is authoritative) with a null Code and
        // a generic Message. Both the (non-success-subtype + status-both-present) and (neither-present) shapes
        // are unprobed; the Task 3 tests below pin only the two captured shapes, so add a test if a probe
        // surfaces either on a CLI upgrade (§9.1).
        string? code = null;
        if (isError)
        {
            var subtype = root.TryGetProperty("subtype", out var s) ? s.GetString() : null;
            code = subtype is not null && subtype != "success"
                ? subtype
                : root.TryGetProperty("api_error_status", out var aes) && aes.ValueKind == JsonValueKind.Number
                    ? aes.GetInt32().ToString(System.Globalization.CultureInfo.InvariantCulture)
                    : subtype; // last resort: whatever subtype was (may be null)
        }
        return new ResultLine(isError, code, fullText, inTok, outTok, cacheTok, cost);
    }

    private static (int, int, int) ReadUsage(JsonElement root)
    {
        if (!root.TryGetProperty("usage", out var u) || u.ValueKind != JsonValueKind.Object) return (0, 0, 0);
        int Get(string k) => u.TryGetProperty(k, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetInt32() : 0;
        return (Get("input_tokens"), Get("output_tokens"), Get("cache_read_input_tokens"));
    }
}
