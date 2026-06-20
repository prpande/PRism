namespace PRism.AI.Contracts.Provider;

/// <summary>
/// Per-session options. SHAPED FOR CLAUDE CODE — the tool/dir fields are Claude-Code CLI concepts; a
/// future second substrate (Ollama, Anthropic API) would refactor this into a substrate-specific
/// discriminated union. Null fields fall back to the provider's configured defaults.
/// <para>Trimmed to the fields a P0-1b Slice-1/Slice-2 consumer actually needs. Fields whose only
/// consumer is a later slice are DEFERRED — added (as nullable optional params, appended at the end so
/// the change is source-non-breaking for existing callers) by the slice that introduces their first
/// consumer: <c>AddDirs</c> (<c>--add-dir</c>; repo-access "state 2") and <c>McpConfigPath</c>
/// (<c>--mcp-config</c>; added with the P0-7 MCP server). (<c>ResumeSessionId</c> landed in Slice 3 / #479.)</para>
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
/// <param name="ResumeSessionId"><c>--resume</c>. When set, resumes the prior <c>claude</c> session with
/// that id, restoring its full conversation context (empirically confirmed on v2.1.177, P0-1b Slice 3 / #479).
/// SEMANTICS the caller MUST honor:
/// (1) WORKING-DIRECTORY-SCOPED — <c>claude</c> keys transcripts per cwd, so the resume MUST use the SAME
///     <see cref="WorkingDirectory"/> as the original session (PRism's stable per-user base satisfies this).
/// (2) FAILS HARD — a resume that cannot find its transcript (cwd mismatch / unknown id) makes <c>claude</c>
///     exit non-zero with no init/result; the caller MUST fall back to fresh-with-injection, never assume a
///     resume yields a usable session. Passing this is therefore an OPTIMIZATION, not a guarantee.
/// (3) RE-PERSIST THE NEW KEY — do not assume the post-resume <see cref="IStreamingLlmSession.ProviderSessionId"/>
///     equals this value (observed equal on v2.1.177, but the CLI is undocumented); persist the post-resume id.
/// OWNERSHIP of the id is verified at the application-service layer BEFORE this is set (#412) — NOT here.</param>
public sealed record StreamingSessionOptions(
    string? Model = null,
    string? AppendSystemPrompt = null,
    string? WorkingDirectory = null,
    IReadOnlyList<string>? AllowedTools = null,
    IReadOnlyList<string>? DisallowedTools = null,
    string? ResumeSessionId = null);
