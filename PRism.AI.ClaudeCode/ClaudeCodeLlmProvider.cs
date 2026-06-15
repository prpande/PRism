using System.ComponentModel;
using System.Text.Json;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// One-shot <see cref="ILlmProvider"/> over the <c>claude</c> CLI. Builds a <see cref="ProcessSpec"/>
/// enforcing every CLI security invariant: never <c>--bare</c>; the child env is an ALLOWLIST that
/// excludes auth + endpoint-redirect vars (ANTHROPIC_API_KEY/_AUTH_TOKEN/_BASE_URL, HTTP(S)_PROXY,
/// and CLAUDE_CONFIG_DIR — a credential-redirect vector); <c>--tools ""</c> (no file/bash);
/// <c>--output-format json</c> for a parseable result.
///
/// <para><c>--exclude-dynamic-system-prompt-sections</c> does NOT delete per-machine sections — it
/// MOVES cwd/env/git/memory into the first user message. Combined with a stable, non-git cwd this
/// ENABLES a byte-stable cache prefix across separate <c>-p</c> processes; whether the prefix is
/// actually stable is MEASURED in P1b (PR1 only emits the flag). The flag is IGNORED when
/// <c>--system-prompt</c> (replace) is set, so we deliberately use <c>--append-system-prompt</c> to
/// keep the cache lever — at the cost of retaining Claude Code's default coding-assistant identity
/// in front of the task (a P1 eval-harness concern).</para>
///
/// <para>NOTE: <see cref="LlmRequest.SystemPrompt"/> is passed via <c>--append-system-prompt</c> and
/// is NOT sanitized here. Sanitizing/length-capping user-edited instruction content is PR3's gate.</para>
/// </summary>
public sealed class ClaudeCodeLlmProvider(ICliProcessRunner runner, ClaudeCodeProviderOptions options)
    : ILlmProvider
{
    public async Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        // #496: evaluate the hot timeout ONCE per call, before building the spec.
        var timeout = options.TimeoutProvider();

        var args = new List<string>
        {
            "-p",
            "--output-format", "json",
            "--model", request.Model,
            "--exclude-dynamic-system-prompt-sections",
            "--tools", "",
            "--append-system-prompt", request.SystemPrompt,
        };
        if (request.JsonSchema is not null)
        {
            args.Add("--json-schema");
            args.Add(request.JsonSchema);
        }

        var spec = new ProcessSpec(
            FileName: options.ClaudeExecutable,
            Arguments: args,
            Environment: ClaudeCliEnvironment.BuildAllowlisted(),
            WorkingDirectory: options.WorkingDirectory,
            StdinText: request.UserContent,
            Timeout: timeout);

        ProcessResult result;
        try
        {
            result = await runner.RunAsync(spec, ct).ConfigureAwait(false);
        }
        catch (Win32Exception ex)
        {
            // Process.Start failed — executable not found / not on PATH (or an invalid working dir).
            // Empty stderr (no process ran); the native cause is preserved as InnerException.
            throw new LlmProviderException(
                "Failed to start the claude process (executable not found or not on PATH).",
                stderr: string.Empty, exitCode: -1, innerException: ex);
        }

        if (result.TimedOut)
            throw new LlmProviderException("claude -p timed out.", result.Stderr, -1, timedOut: true);
        if (result.ExitCode != 0)
            throw new LlmProviderException($"claude -p failed (exit {result.ExitCode}).", result.Stderr, result.ExitCode);

        var envelope = JsonSerializer.Deserialize<ClaudeCliEnvelope>(result.Stdout, ClaudeCliEnvelope.Options)
            ?? throw new LlmProviderException("claude -p returned unparseable JSON.", stderr: string.Empty, exitCode: 0);
        if (envelope.Result is null)
            throw new LlmProviderException("claude -p returned JSON without a result field.", stderr: string.Empty, exitCode: 0);

        var usage = envelope.Usage;
        return new LlmResult(
            Text: envelope.Result,
            InputTokens: usage?.InputTokens ?? 0,
            OutputTokens: usage?.OutputTokens ?? 0,
            CacheReadInputTokens: usage?.CacheReadInputTokens ?? 0,
            EstimatedCostUsd: envelope.TotalCostUsd);
    }
}
