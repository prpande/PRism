using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>Real <see cref="IStreamingLlmProvider"/> over the persistent <c>claude</c> stream-json session.
/// Enforces every spec §6 invariant: env allowlist, unconditional tool deny-list, working-dir
/// confinement (canonical + symlink-resolved), mandatory <c>--verbose</c>.</summary>
public sealed class ClaudeCodeStreamingProvider(
    IStreamingCliProcessFactory factory,
    ClaudeCodeProviderOptions providerOptions,
    ILoggerFactory? loggerFactory = null) : IStreamingLlmProvider
{
    // The session's drift-guard warnings (Task 8: MalformedResult / ZeroOutputTurn) only reach an operator
    // sink if the session is built with a REAL logger. The provider is the PRODUCTION construction site, so
    // it must inject one — DI supplies ILoggerFactory. Defaulting to NullLoggerFactory keeps the 2-arg
    // test/manual-P1 construction path working without forcing a logger on every caller.
    private readonly ILoggerFactory _loggerFactory = loggerFactory ?? NullLoggerFactory.Instance;

    // Forced-deny: the write/exec-capable tools, taken from the PROBED v2.1.177 init `tools` array
    // (.scratch probe 5). NOTE there is NO "Computer"/"computer-use" tool in this CLI — do not ship a
    // phantom. `PowerShell` IS present (a Windows shell-exec tool) and MUST be denied alongside `Bash`.
    // `--allowedTools` restricted to the read-only set is the primary lever; this deny list is
    // belt-and-suspenders for exec/write. (Re-confirm against a fresh init line on CLI upgrade — § 9.1.)
    private static readonly string[] ForcedDeny =
        ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit"];
    private static readonly string[] DefaultAllow = ["Read", "Glob", "Grep"];

    public IStreamingLlmSession StartSession(StreamingSessionOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);

        var workingDir = ConfineWorkingDirectory(options.WorkingDirectory);
        var (allow, deny) = MergeTools(options.AllowedTools, options.DisallowedTools);

        var args = new List<string>
        {
            "-p", "--verbose",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--allowedTools", string.Join(",", allow),
            "--disallowedTools", string.Join(",", deny),
        };
        if (options.Model is not null) { args.Add("--model"); args.Add(options.Model); }
        if (options.AppendSystemPrompt is not null) { args.Add("--append-system-prompt"); args.Add(options.AppendSystemPrompt); }
        if (options.ResumeSessionId is not null)
        {
            ValidateCliToken(options.ResumeSessionId, nameof(options.ResumeSessionId));
            args.Add("--resume"); args.Add(options.ResumeSessionId);
        }

        var spec = new StreamingProcessSpec(
            FileName: providerOptions.ClaudeExecutable,
            Arguments: args,
            Environment: ClaudeCliEnvironment.BuildAllowlisted(),
            WorkingDirectory: workingDir);

        return new ClaudeCodeStreamingSession(
            factory.Start(spec), _loggerFactory.CreateLogger<ClaudeCodeStreamingSession>());
    }

    private static (IReadOnlyList<string> allow, IReadOnlyList<string> deny) MergeTools(
        IReadOnlyList<string>? callerAllow, IReadOnlyList<string>? callerDeny)
    {
        ValidateToolNames(callerAllow);
        ValidateToolNames(callerDeny);
        // Deny wins: forced-deny ∪ caller-deny; allow = (default ∪ caller-allow) minus anything denied.
        var deny = new HashSet<string>(ForcedDeny, StringComparer.OrdinalIgnoreCase);
        if (callerDeny is not null) deny.UnionWith(callerDeny);
        var allow = new HashSet<string>(DefaultAllow, StringComparer.OrdinalIgnoreCase);
        if (callerAllow is not null) allow.UnionWith(callerAllow);
        allow.ExceptWith(deny);                       // never allow a denied tool
        return (allow.ToArray(), deny.ToArray());
    }

    // A tool name is ONE CLI token in the comma-joined --allowedTools/--disallowedTools value. Reject any
    // caller value with an embedded comma (would split the list and smuggle a denied tool past the deny-set
    // check — `ExceptWith` matches whole strings, so "Read,Bash" ≠ "Bash" and expands to an allowed Bash at
    // the CLI), a leading "--" (would be misread as a flag), or whitespace. Forced/default names are clean.
    private static void ValidateToolNames(IReadOnlyList<string>? names)
    {
        if (names is null) return;
        foreach (var n in names)
        {
            if (string.IsNullOrWhiteSpace(n) || n.Contains(',', StringComparison.Ordinal) || n.StartsWith("--", StringComparison.Ordinal)
                || n.Any(char.IsWhiteSpace))
                throw new ArgumentException(
                    $"Invalid tool name '{n}': must be a single token with no comma, leading '--', or whitespace.");
        }
    }

    // A single CLI argv VALUE (not a comma-joined list element). Reject empty/whitespace and any control
    // char (incl. NUL — char.IsWhiteSpace('\0') is FALSE, so the IsWhiteSpace clause alone would let it
    // through), and a leading "--" (would be misread as a flag). A comma cannot split a standalone argv
    // slot into a second argument under the pre-split ArgumentList + UseShellExecute=false spawn, so the
    // comma check is conservative shape validation only — NOT the list-injection reason ValidateToolNames
    // documents. Authorization of the id is a separate concern enforced upstream (#412), not here.
    private static void ValidateCliToken(string value, string argName)
    {
        if (string.IsNullOrWhiteSpace(value) || value.StartsWith("--", StringComparison.Ordinal)
            || value.Any(char.IsWhiteSpace) || value.Any(char.IsControl)
            || value.Contains(',', StringComparison.Ordinal))
            throw new ArgumentException(
                $"Invalid {argName} '{value}': must be a single token with no whitespace, control char, leading '--', or comma.");
    }

    private string ConfineWorkingDirectory(string? requested)
    {
        var baseReal = RealPath(providerOptions.WorkingDirectory);   // operator-configured base (must exist)
        if (requested is null) return baseReal;

        // Reject a non-existent requested dir OUTRIGHT — we will not lexically "normalize" a path whose
        // real location we cannot resolve. (Falling back to the lexical form is the parent-symlink-escape
        // hole: `<base>/link/nonexistent` would pass a lexical prefix check while `link` points outside.)
        if (!Directory.Exists(requested))
            throw new ArgumentException($"WorkingDirectory '{requested}' does not exist.");

        var real = RealPath(requested);
        var rel = Path.GetRelativePath(baseReal, real);
        if (rel == ".." || rel.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            || Path.IsPathRooted(rel))
            throw new ArgumentException($"WorkingDirectory '{requested}' is outside the sanctioned base.");
        return real;
    }

    // Canonical REAL path. `Path.GetFullPath` collapses '..' LEXICALLY only; `ResolveLinkTarget` resolves
    // just the LEAF — so a symlinked PARENT would slip a lexical check. Resolve COMPONENT-BY-COMPONENT
    // (leaf, then recurse on the resolved parent) so an intermediate symlink is followed too. Callers
    // guarantee the path exists.
    private static string RealPath(string path)
    {
        var full = Path.GetFullPath(path);
        // Stop at the drive/FS root — it cannot be a symlink and ResolveLinkTarget throws on Windows roots.
        if (full == Path.GetPathRoot(full)) return full;
        string resolved;
        try { resolved = Directory.ResolveLinkTarget(full, returnFinalTarget: true)?.FullName ?? full; }
        catch (IOException) { resolved = full; }   // root or OS-level restriction: treat as non-link
        var parent = Path.GetDirectoryName(resolved);
        if (parent is null || !Directory.Exists(parent)) return resolved;   // reached a root
        return Path.Combine(RealPath(parent), Path.GetFileName(resolved));
    }
}
