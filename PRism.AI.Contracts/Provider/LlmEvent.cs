using System.Text.Json;

namespace PRism.AI.Contracts.Provider;

/// <summary>
/// A streaming event from an <see cref="IStreamingLlmSession"/>. This is an OPEN hierarchy (it is NOT
/// sealed): consumers switch on the known subtypes with a default arm and ignore unrecognized subtypes,
/// so a future subtype (e.g. a recoverable per-turn error event introduced in P0-1b Slice 2) is a
/// non-breaking addition.
/// </summary>
public abstract record LlmEvent;

/// <summary>An incremental chunk of assistant text within the current turn.</summary>
public sealed record LlmTextDelta(string Text) : LlmEvent;

/// <summary>The model invoked a tool. <paramref name="Input"/> is the raw tool input as reported by
/// the provider; the host does not interpret it for non-MCP tools. The element must remain valid for
/// this event's lifetime — the provider impl clones it (<see cref="JsonElement.Clone"/>) or owns the
/// backing <see cref="JsonDocument"/> and disposes it only after the consumer has processed the event,
/// since a <see cref="JsonElement"/> over a disposed document throws on access.</summary>
public sealed record LlmToolUse(string ToolName, JsonElement Input) : LlmEvent;

/// <summary>Terminal event for one turn: the assembled whole-turn text plus usage. Exactly one is
/// emitted per turn (the consumer's turn-loop terminal condition). <paramref name="FullText"/> is
/// deliberately not named <c>Text</c> — it is the assembled whole-turn text, distinct from
/// <see cref="LlmTextDelta.Text"/> (a partial chunk). The four token fields are flattened to match the
/// shipped one-shot <see cref="LlmResult"/>.</summary>
public sealed record LlmTurnComplete(
    string FullText,
    int InputTokens,
    int OutputTokens,
    int CacheReadInputTokens,
    decimal EstimatedCostUsd) : LlmEvent;
