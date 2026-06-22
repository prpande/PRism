namespace PRism.AI.ClaudeCode;

/// <summary>
/// Owns CLI resolution + persistence + self-heal (spec §§3–7). Single-flighted by a
/// <see cref="SemaphoreSlim"/>(1,1) with double-check (mirrors <c>CachedLlmAvailabilityProbe</c>) so
/// the eager Live-entry trigger and any concurrent probe never spawn N login shells.
/// </summary>
public sealed class ClaudeCliLocator : IClaudeCliLocator, IDisposable
{
    private readonly ILoginShellEnvironmentReader _reader;
    private readonly JsonClaudeCliStateStore _store;
    private readonly ICliProcessRunner _runner;
    private readonly ClaudeCodeProviderOptions _options;
    private readonly Func<bool> _identityMatches;
    private readonly TimeProvider _clock;
    private readonly Func<string, bool> _pathExists;
    private readonly SemaphoreSlim _gate = new(1, 1);

    // value + timestamp wrapped in ONE immutable record so the lock-free fast-path read is a single
    // reference load — never a torn multi-word struct read on weak-memory targets (macOS is arm64).
    // This mirrors CachedLlmAvailabilityProbe.CacheEntry, whose comment documents exactly this hazard.
    private sealed record NegativeEntry(NotFound Value, DateTimeOffset At);

    private ResolvedCli? _resolved;                       // sticky positive snapshot (reference read = atomic)
    private NegativeEntry? _negative;                     // in-memory TTL only (single ref read = tear-free)

    private static readonly string[] LadderRelativeToHome =
        [".local/bin/claude"];
    private static readonly string[] LadderAbsolute =
        ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

    public ClaudeCliLocator(
        ILoginShellEnvironmentReader reader,
        JsonClaudeCliStateStore store,
        ICliProcessRunner runner,
        ClaudeCodeProviderOptions options,
        Func<bool> identityMatches,
        TimeProvider clock,
        Func<string, bool>? pathExists = null)
    {
        _reader = reader;
        _store = store;
        _runner = runner;
        _options = options;
        _identityMatches = identityMatches;
        _clock = clock;
        // Test seam ONLY (defaults to File.Exists) — lets the locator tests drive candidate/ladder
        // existence without touching the filesystem. Not an extension point; DI never sets it.
        _pathExists = pathExists ?? File.Exists;
    }

    public ClaudeCliResolution? CurrentResolved => _resolved;

    public void InvalidateResolved()
    {
        // Discard the sticky positive AND the persisted record so warm reuse cannot re-serve a path
        // whose binary no longer launches (spec §6: "discard the record and re-discover"). Deleting
        // the disk record is what breaks the warm-reuse → spawn-fail → invalidate loop for a
        // present-but-broken install (e.g. an npm shim whose `node` was removed): without it, every
        // request reloads the same dead record from disk. Leave _negative intact — invalidation only
        // ever follows a POSITIVE resolve (an exec-not-found can only come from a spawn we resolved),
        // so clearing the negative here would only remove the backoff that throttles re-discovery.
        _resolved = null;
        _store.Delete();
    }

    public async Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct)
    {
        // Identity is cheap and runs on EVERY call (warm + cold), never cached (spec §6).
        if (!_identityMatches()) return new NotFound(ClaudeReasonCodes.IdentityMismatch);

        // Lock-free fast paths.
        var resolved = _resolved;
        if (resolved is not null) return resolved;
        var neg = _negative;
        if (neg is not null && _clock.GetUtcNow() - neg.At < _options.NegativeTtl) return neg.Value;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Double-check after acquiring the gate.
            resolved = _resolved;
            if (resolved is not null) return resolved;
            neg = _negative;
            if (neg is not null && _clock.GetUtcNow() - neg.At < _options.NegativeTtl) return neg.Value;

            // Windows: exact no-op — inherited bare-name invocation, no discovery, no persistence.
            if (OperatingSystem.IsWindows())
            {
                var windows = new ResolvedCli(_options.ClaudeExecutable, ClaudeCliEnvironment.BuildAllowlisted());
                _resolved = windows;
                return windows;
            }

            var result = await ResolveUnixAsync(ct).ConfigureAwait(false);
            if (result is ResolvedCli ok)
            {
                _resolved = ok;
                _negative = null;
                return ok;
            }

            var notFound = (NotFound)result;
            _negative = new NegativeEntry(notFound, _clock.GetUtcNow());
            return notFound;
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task<ClaudeCliResolution> ResolveUnixAsync(CancellationToken ct)
    {
        // Warm path: a persisted positive record is reused iff its executable still exists. NO spawn
        // here — the node-manager-swap case (shim present, pinned node gone) is caught lazily when the
        // next real spawn hits exec-not-found and calls InvalidateResolved (spec §6). Load() has
        // already rejected a foreign-platform record.
        var record = _store.Load();
        if (record is not null && _pathExists(record.ExecutablePath))
            return new ResolvedCli(record.ExecutablePath, JsonClaudeCliStateStore.RebuildEnv(record));

        return await DiscoverColdAsync(ct).ConfigureAwait(false);
    }

    private async Task<ClaudeCliResolution> DiscoverColdAsync(CancellationToken ct)
    {
        var capture = await _reader.CaptureAsync(_options.DiscoveryTimeout, ct).ConfigureAwait(false);
        if (capture is not null)
        {
            var env = ClaudeCliEnvironment.FilterCaptured(capture.Environment);
            var candidate = PickCandidate(capture, env);
            if (candidate is not null)
            {
                var version = await RunVersionAsync(candidate, env, ct).ConfigureAwait(false);
                if (version is { ExitCode: 0, TimedOut: false })
                    return Persist(candidate, env, version.Stdout, "login-shell");
            }
        }

        // Degradation ladder (native topology; no node needed). Each re-validated by executing.
        var ladderEnv = ClaudeCliEnvironment.BuildAllowlisted();   // minimal env is enough for a self-contained binary
        // The ladder runs precisely when login-shell capture failed (non-POSIX shell, Gatekeeper block,
        // timeout) — i.e. a Finder-launched .app, where the launchd env can be minimal and HOME may be
        // unset. Fall back to the OS user-profile dir so ~/.local/bin (the PRIMARY native-installer
        // location this ladder exists to rescue) is still probed. We do NOT synthesize HOME into
        // ladderEnv: the child's credential lookup keys off the real profile and is the liveness tier's
        // concern, not discovery's (spec §1 scope-bound). (See P1: confirm HOME presence in a real .app.)
        var home = Environment.GetEnvironmentVariable("HOME");
        if (string.IsNullOrEmpty(home))
            home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var ladder = new List<string>();
        if (!string.IsNullOrEmpty(home))
            foreach (var rel in LadderRelativeToHome) ladder.Add(Path.Combine(home, rel));
        ladder.AddRange(LadderAbsolute);

        foreach (var path in ladder)
        {
            if (!_pathExists(path)) continue;
            var version = await RunVersionAsync(path, ladderEnv, ct).ConfigureAwait(false);
            if (version is { ExitCode: 0, TimedOut: false })
                return Persist(path, ladderEnv, version.Stdout, "ladder");
        }

        return new NotFound(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    // command -v result IF it is an absolute path to an existing file; else resolve `claude` against
    // the captured PATH. A non-path result (alias/function/builtin) yields no candidate.
    private string? PickCandidate(LoginShellCapture capture, Dictionary<string, string> env)
    {
        var cv = capture.CommandVClaude;
        if (!string.IsNullOrEmpty(cv) && Path.IsPathRooted(cv) && _pathExists(cv)) return cv;

        if (env.TryGetValue("PATH", out var path))
        {
            foreach (var dir in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                var candidate = Path.Combine(dir, "claude");
                if (_pathExists(candidate)) return candidate;
            }
        }
        return null;
    }

    private async Task<ProcessResult?> RunVersionAsync(
        string executablePath, IReadOnlyDictionary<string, string> env, CancellationToken ct)
    {
        var spec = new ProcessSpec(
            FileName: executablePath,
            Arguments: ["--version"],
            Environment: env,
            WorkingDirectory: _options.WorkingDirectory,
            StdinText: null,
            Timeout: _options.ProbeTimeout);
        try
        {
            return await _runner.RunAsync(spec, ct).ConfigureAwait(false);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            return null;   // not launchable at this path
        }
    }

    private ResolvedCli Persist(
        string executablePath, Dictionary<string, string> env, string versionStdout, string source)
    {
        var managerVars = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var key in ClaudeCliEnvironment.ManagerVarAllowlist)
            if (env.TryGetValue(key, out var managerVal)) managerVars[key] = managerVal;

        env.TryGetValue("PATH", out var pathValue);
        var trimmedVersion = versionStdout.Trim();
        _store.Save(new ClaudeCliStateRecord(
            SchemaVersion: JsonClaudeCliStateStore.CurrentSchemaVersion,
            Platform: JsonClaudeCliStateStore.CurrentPlatform,
            ExecutablePath: executablePath,
            Path: pathValue ?? string.Empty,
            ManagerVars: managerVars,
            CliVersion: trimmedVersion.Length > 0 ? trimmedVersion : null,
            DiscoveredAt: _clock.GetUtcNow(),
            DiscoverySource: source));

        return new ResolvedCli(executablePath, env);
    }

    public void Dispose() => _gate.Dispose();
}
