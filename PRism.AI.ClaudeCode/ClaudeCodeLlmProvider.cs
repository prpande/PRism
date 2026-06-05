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
    // Only what the CLI needs to find itself + the user profile that holds the /login credential.
    // Omits ANTHROPIC_* and proxy vars (HTTP(S)_PROXY/ALL_PROXY/NO_PROXY are simply not on the list)
    // and CLAUDE_CONFIG_DIR, so an inherited value can neither override the subscription nor redirect
    // egress/credentials. (The Node CLI may additionally need APPDATA/LOCALAPPDATA — to be verified
    // empirically in P1 against the real binary; add them then if `claude --version` fails in-child.)
    private static readonly string[] EnvAllowlist =
        ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL"];

    public async Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

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
            Environment: BuildAllowlistedEnv(),
            WorkingDirectory: options.WorkingDirectory,
            StdinText: request.UserContent,
            Timeout: options.Timeout);

        ProcessResult result;
        try
        {
            result = await runner.RunAsync(spec, ct).ConfigureAwait(false);
        }
        catch (Win32Exception ex)
        {
            // Process.Start throws this when the executable is absent / not on PATH.
            throw new LlmProviderException("claude executable not found.", ex.Message, -1);
        }

        if (result.TimedOut)
            throw new LlmProviderException("claude -p timed out.", result.Stderr, -1);
        if (result.ExitCode != 0)
            throw new LlmProviderException($"claude -p failed (exit {result.ExitCode}).", result.Stderr, result.ExitCode);

        var envelope = JsonSerializer.Deserialize<ClaudeCliEnvelope>(result.Stdout, ClaudeCliEnvelope.Options)
            ?? throw new LlmProviderException("claude -p returned unparseable JSON.", result.Stdout, 0);
        if (envelope.Result is null)
            throw new LlmProviderException("claude -p returned JSON without a result field.", result.Stdout, 0);

        var usage = envelope.Usage;
        return new LlmResult(
            Text: envelope.Result,
            InputTokens: usage?.InputTokens ?? 0,
            OutputTokens: usage?.OutputTokens ?? 0,
            CacheReadInputTokens: usage?.CacheReadInputTokens ?? 0,
            EstimatedCostUsd: envelope.TotalCostUsd);
    }

    private static Dictionary<string, string> BuildAllowlistedEnv()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in EnvAllowlist)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (value is not null) env[key] = value;
        }
        return env;
    }
}
