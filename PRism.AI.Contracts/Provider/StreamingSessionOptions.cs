namespace PRism.AI.Contracts.Provider;

/// <summary>
/// Per-session options. SHAPED FOR CLAUDE CODE — the tool/dir fields are Claude-Code CLI concepts; a
/// future second substrate (Ollama, Anthropic API) would refactor this into a substrate-specific
/// discriminated union. Null fields fall back to the provider's configured defaults.
/// <para>Trimmed to the fields a P0-1b Slice-1/Slice-2 consumer actually needs. Fields whose only
/// consumer is a later slice are DEFERRED — added (as nullable optional params, appended at the end so
/// the change is source-non-breaking for existing callers) by the slice that introduces their first
/// consumer: <c>AddDirs</c> (<c>--add-dir</c>; repo-access "state 2"), <c>ResumeSessionId</c>
/// (<c>--resume</c>; added in Slice 3 once the resume probe pins its semantics), and
/// <c>McpConfigPath</c> (<c>--mcp-config</c>; added with the P0-7 MCP server).</para>
/// </summary>
/// <param name="Model"><c>--model</c>; null uses the provider's configured default.</param>
/// <param name="AppendSystemPrompt"><c>--append-system-prompt</c>. NOT sanitized at the provider
/// (PR3's sanitization gate owns user-edited instruction content). Because a streaming session is
/// spawned once, this is evaluated at session-start only — the sanitization window does not reopen per
/// turn. A caller must not route content whose source can mutate after spawn (e.g. a PR description)
/// through this; a changed source requires tearing down and re-spawning the session, not resuming.</param>
/// <param name="WorkingDirectory">Session cwd; null uses the provider default (a stable, non-git dir).
/// When supplied it must be confined by the impl to an operator-sanctioned base directory.</param>
/// <param name="AllowedTools"><c>--allowedTools</c>. The session's default-deny tool-restriction lever
/// (the streaming analogue of the one-shot's <c>--tools ""</c>); the impl enforces a server-side cap
/// and forced-deny set callers cannot override.</param>
/// <param name="DisallowedTools"><c>--disallowedTools</c>.</param>
public sealed record StreamingSessionOptions(
    string? Model = null,
    string? AppendSystemPrompt = null,
    string? WorkingDirectory = null,
    IReadOnlyList<string>? AllowedTools = null,
    IReadOnlyList<string>? DisallowedTools = null);
