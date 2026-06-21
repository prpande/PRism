# Claude CLI Discovery & Runtime Resolution (macOS) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `claude` CLI resolve and run from the packaged macOS `.app` regardless of install topology (native binary or npm-with-node-shebang), discovering once and persisting the result, with zero behavior change on Windows.

**Architecture:** A new `IClaudeCliLocator` in `PRism.AI.ClaudeCode` owns resolution: it reproduces the user's login-shell environment (`$SHELL -ilc`) to capture the `PATH` + node-manager vars under which `claude` actually runs, validates by executing `claude --version`, and persists the minimum needed to rebuild the child env. The one-shot provider and availability probe call `ResolveAsync` instead of reading the static `ClaudeExecutable` + `BuildAllowlisted()`; the synchronous streaming provider reads a memoized snapshot. Windows is an OS-gated no-op that returns today's inherited invocation.

**Tech Stack:** C# / .NET 10, xUnit + FluentAssertions, `System.Diagnostics.Process`, `System.Text.Json`. The existing `ICliProcessRunner`/`FakeCliProcessRunner` seam keeps everything except the OS shell-spawn unit-testable.

## Global Constraints

Copied verbatim from the spec (`docs/specs/2026-06-22-claude-cli-discovery-macos-design.md`). Every task's requirements implicitly include this section.

- **Allowlist-only env, never a denylist.** The child env handed to `claude` is built by copying *only* keys in (base allowlist ∪ manager-var allowlist) from the captured env.
- **Never allowlisted (must never appear in the child env or on disk):** `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `CLAUDE_CONFIG_DIR`, `NODE_OPTIONS`, `NODE_EXTRA_CA_CERTS`.
- **Base allowlist:** `PATH`, `HOME`, `USERPROFILE`, `SystemRoot`, `TEMP`, `TMP`, `LANG`, `LC_ALL`, **`TMPDIR`** (new).
- **Manager-var allowlist (path-pointing only):** `NVM_DIR`, `VOLTA_HOME`, `ASDF_DIR`, `ASDF_DATA_DIR`, `FNM_DIR`, `N_PREFIX`, `NPM_CONFIG_PREFIX`, `PNPM_HOME`.
- **POSIX env matching is case-sensitive** (`StringComparer.Ordinal`). Windows/fallback path keeps `OrdinalIgnoreCase`.
- **Persist positive results only**, and only `path` + `managerVars` (never the full env). Rebuild the child env from those on load through the same filter.
- **Persisted file is mode `600` inside a `700` dir, written atomically** (temp-file + rename).
- **Discovery is Unix-only.** `ResolveAsync` is `OperatingSystem.IsWindows()`-gated and returns the inherited invocation (bare `"claude"` + `BuildAllowlisted()`) on Windows. **Zero behavior change on Windows and in existing tests.**
- **Identity invariant** (`ClaudeIdentity.SameOsUserAsCredentialStore()`) holds on every resolution (warm reuse and cold discovery).
- **`claude --version` exit 0 proves resolution + executability only** — never credential/credit/network viability (that stays the liveness tier's job).
- **TDD, red → green → refactor, every commit.** Build/test commands (run from repo root, i.e. the worktree root): `dotnet build --configuration Release` then `dotnet test --no-build --configuration Release --settings .runsettings`. To scope a single test project: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings`.

---

## File Structure

**New files (all in `PRism.AI.ClaudeCode/` unless noted):**

- `ClaudeCliResolution.cs` — the `ResolvedCli` / `NotFound` result type (abstract record + two subtypes).
- `ClaudeCliStateRecord.cs` — the persisted-record DTO.
- `JsonClaudeCliStateStore.cs` — read/write the record in the dataDir (atomic, `600`/`700`); rebuilds env on load.
- `LoginShellCapture.cs` — the captured `(Environment, CommandVClaude)` result record.
- `ILoginShellEnvironmentReader.cs` — the login-shell capture seam (interface).
- `SystemLoginShellEnvironmentReader.cs` — real `$SHELL -ilc` spawn (manual P1) + `internal static ParseCapture`.
- `IClaudeCliLocator.cs` — `ResolveAsync` / `CurrentResolved` / `InvalidateResolved` (interface).
- `ClaudeCliLocator.cs` — the orchestrator.
- `ClaudeExecSignatures.cs` — shared executable-not-found stderr signature detector (probe + provider).
- `PRism.Web/Ai/ClaudeCliDiscoveryWarmup.cs` — `IHostedService` eager trigger on Live-entry.

**Modified files:**

- `ClaudeReasonCodes.cs` — add `CliDiscoveryFailed`.
- `ClaudeCliEnvironment.cs` — add `TMPDIR`, the manager-var allowlist, and `FilterCaptured`.
- `ClaudeCodeProviderOptions.cs` — add `DiscoveryTimeout`, `NegativeTtl`.
- `ClaudeCodeAvailabilityProbe.cs` — call the locator; map `NotFound`; self-heal invalidate.
- `ClaudeCodeLlmProvider.cs` — call the locator; self-heal invalidate.
- `ClaudeCodeStreamingProvider.cs` — read `CurrentResolved` with fallback.
- `ServiceCollectionExtensions.cs` (`PRism.AI.ClaudeCode`) — register the locator + reader + state store.
- `PRism.Web/Composition/ServiceCollectionExtensions.cs` — non-compounding-TTL passthrough.
- `PRism.Web/Program.cs` — register the warmup hosted service.

**Test files (in `tests/PRism.AI.ClaudeCode.Tests/` unless noted):**

- `ClaudeCliEnvironmentTests.cs`, `JsonClaudeCliStateStoreTests.cs`, `LoginShellCaptureParseTests.cs`, `ClaudeCliLocatorTests.cs`, `FakeLoginShellEnvironmentReader.cs` (new test double).
- Modify `ClaudeCodeAvailabilityProbeTests.cs`, `ClaudeCodeLlmProviderTests.cs`, `ClaudeCodeStreamingProviderTests.cs`.
- `tests/PRism.Web.Tests/Ai/CachedLlmAvailabilityProbeTests.cs` (modify), `tests/PRism.Web.Tests/Ai/ClaudeCliDiscoveryWarmupTests.cs` (new).

---

## Task 1: Resolution result type + new reason code

**Files:**
- Create: `PRism.AI.ClaudeCode/ClaudeCliResolution.cs`
- Modify: `PRism.AI.ClaudeCode/ClaudeReasonCodes.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliResolutionTests.cs`

**Interfaces:**
- Produces: `abstract record ClaudeCliResolution`; `sealed record ResolvedCli(string ExecutablePath, IReadOnlyDictionary<string,string> Environment) : ClaudeCliResolution`; `sealed record NotFound(string ReasonCode) : ClaudeCliResolution`. New constant `ClaudeReasonCodes.CliDiscoveryFailed = "cli-discovery-failed"`.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliResolutionTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliResolutionTests
{
    [Fact]
    public void ResolvedCli_carries_path_and_env()
    {
        var env = new Dictionary<string, string> { ["PATH"] = "/usr/bin" };
        ClaudeCliResolution res = new ResolvedCli("/opt/homebrew/bin/claude", env);

        res.Should().BeOfType<ResolvedCli>()
            .Which.ExecutablePath.Should().Be("/opt/homebrew/bin/claude");
        ((ResolvedCli)res).Environment.Should().ContainKey("PATH");
    }

    [Fact]
    public void NotFound_carries_reason_code()
    {
        ClaudeCliResolution res = new NotFound(ClaudeReasonCodes.CliDiscoveryFailed);
        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be("cli-discovery-failed");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliResolutionTests`
Expected: FAIL — `ClaudeCliResolution` / `ResolvedCli` / `NotFound` do not exist (compile error).

- [ ] **Step 3: Write minimal implementation**

Create `PRism.AI.ClaudeCode/ClaudeCliResolution.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>Result of resolving the <c>claude</c> CLI: either a launchable invocation
/// (<see cref="ResolvedCli"/>) or a failure with a reason code (<see cref="NotFound"/>).</summary>
public abstract record ClaudeCliResolution;

/// <summary>A launchable invocation: the executable path and the exact ALLOWLISTED child env to
/// spawn it under. Both topologies (native binary, npm+node shebang) collapse to this shape.</summary>
public sealed record ResolvedCli(
    string ExecutablePath,
    IReadOnlyDictionary<string, string> Environment) : ClaudeCliResolution;

/// <summary>No launchable <c>claude</c> was found. <paramref name="ReasonCode"/> is a
/// <see cref="ClaudeReasonCodes"/> value the availability probe maps to its vocabulary.</summary>
public sealed record NotFound(string ReasonCode) : ClaudeCliResolution;
```

Modify `PRism.AI.ClaudeCode/ClaudeReasonCodes.cs` — add the constant after `CliNotInstalled`:

```csharp
    public const string CliNotInstalled = "cli-not-installed";

    /// <summary>Discovery ran but could not produce a launchable binary (e.g. non-POSIX shell +
    /// ladder miss, or a manager-var gap). Distinguishes "installed but not discoverable" from a
    /// clean "not installed" — so logs (and any future UI) can tell them apart.</summary>
    public const string CliDiscoveryFailed = "cli-discovery-failed";
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliResolutionTests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCliResolution.cs PRism.AI.ClaudeCode/ClaudeReasonCodes.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCliResolutionTests.cs
git commit -m "feat(ai): add ClaudeCliResolution result type + CliDiscoveryFailed reason code"
```

---

## Task 2: Env filter — manager-var allowlist, TMPDIR, case-sensitive POSIX matching

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCliEnvironment.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliEnvironmentTests.cs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClaudeCliEnvironment.ManagerVarAllowlist` (`string[]`); `ClaudeCliEnvironment.FilterCaptured(IReadOnlyDictionary<string,string> captured) → Dictionary<string,string>`. `Allowlist` (base) now includes `"TMPDIR"`. `BuildAllowlisted()` is unchanged (still `OrdinalIgnoreCase`, still reads from `Environment`).

`FilterCaptured` copies, from `captured`, only keys present in (`Allowlist` ∪ `ManagerVarAllowlist`), using **case-sensitive** (`StringComparer.Ordinal`) matching on POSIX and `OrdinalIgnoreCase` on Windows. It is the path the locator uses to build the child env from a captured/rebuilt login-shell env.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliEnvironmentTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliEnvironmentTests
{
    [Fact]
    public void FilterCaptured_keeps_base_and_manager_vars_only()
    {
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/opt/homebrew/bin:/usr/bin",
            ["HOME"] = "/Users/x",
            ["TMPDIR"] = "/var/folders/tmp",
            ["VOLTA_HOME"] = "/Users/x/.volta",
            ["NVM_DIR"] = "/Users/x/.nvm",
            ["RANDOM_UNLISTED"] = "nope",
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Should().ContainKey("PATH");
        env.Should().ContainKey("HOME");
        env.Should().ContainKey("TMPDIR");
        env.Should().ContainKey("VOLTA_HOME");
        env.Should().ContainKey("NVM_DIR");
        env.Should().NotContainKey("RANDOM_UNLISTED");
    }

    [Fact]
    public void FilterCaptured_strips_credential_redirect_and_node_option_vars()
    {
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/usr/bin",
            ["ANTHROPIC_API_KEY"] = "sk-leak",
            ["ANTHROPIC_BASE_URL"] = "http://evil",
            ["HTTPS_PROXY"] = "http://evil",
            ["NO_PROXY"] = "localhost",
            ["CLAUDE_CONFIG_DIR"] = "/tmp/evil",
            ["NODE_OPTIONS"] = "--require /tmp/evil.js",
            ["NODE_EXTRA_CA_CERTS"] = "/tmp/evil.pem",
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Keys.Should().BeEquivalentTo(new[] { "PATH" });
    }

    [SkippableFact]
    public void FilterCaptured_is_case_sensitive_on_posix()
    {
        Skip.If(OperatingSystem.IsWindows(), "POSIX env vars are case-sensitive; Windows is not.");
        var captured = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["PATH"] = "/usr/bin",
            ["nvm_dir"] = "/should/not/match",   // lowercase must NOT be treated as NVM_DIR
        };

        var env = ClaudeCliEnvironment.FilterCaptured(captured);

        env.Should().NotContainKey("nvm_dir");
        env.Should().NotContainKey("NVM_DIR");
    }

    [Fact]
    public void Base_allowlist_includes_tmpdir()
    {
        ClaudeCliEnvironment.Allowlist.Should().Contain("TMPDIR");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliEnvironmentTests`
Expected: FAIL — `FilterCaptured` and `ManagerVarAllowlist` do not exist; `Allowlist` lacks `TMPDIR`.

- [ ] **Step 3: Write minimal implementation**

Replace `PRism.AI.ClaudeCode/ClaudeCliEnvironment.cs` with:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>
/// The env ALLOWLIST for spawning the `claude` CLI, shared by the provider and the availability
/// probe so both run in an identical environment. Only what the CLI needs to find itself + the
/// user profile that holds the /login credential, plus the node-version-manager vars an
/// npm-installed `claude` needs to exec its `node` shebang. Deliberately omits ANTHROPIC_*, proxy,
/// CLAUDE_CONFIG_DIR, and NODE_OPTIONS/NODE_EXTRA_CA_CERTS, so an inherited or captured value can
/// neither override the subscription, redirect egress/credentials, nor inject modules into node.
/// </summary>
internal static class ClaudeCliEnvironment
{
    /// <summary>Base vars: locate the CLI + the user profile that holds the /login credential.
    /// TMPDIR is the macOS/Unix temp var (Windows uses TEMP/TMP, which it sets instead).</summary>
    public static readonly string[] Allowlist =
        ["PATH", "HOME", "USERPROFILE", "SystemRoot", "TEMP", "TMP", "LANG", "LC_ALL", "TMPDIR"];

    /// <summary>Node-version-manager vars, PATH-POINTING ONLY (no credential/redirect). An
    /// npm-installed `claude` (shebang `#!/usr/bin/env node`) needs these so a shim manager
    /// (volta/asdf/fnm) can resolve `node`. Expansion is gated (spec §10). NEVER add a var that can
    /// carry a credential or redirect egress — every var here is persisted to disk and passed to the
    /// child. In particular NPM_CONFIG_PREFIX is included but per-registry auth tokens
    /// (NPM_CONFIG_//registry…/:_authToken) do NOT match it and are excluded.</summary>
    public static readonly string[] ManagerVarAllowlist =
        ["NVM_DIR", "VOLTA_HOME", "ASDF_DIR", "ASDF_DATA_DIR", "FNM_DIR", "N_PREFIX", "NPM_CONFIG_PREFIX", "PNPM_HOME"];

    /// <summary>POSIX env vars are case-sensitive; Windows is not. A case-collision must never admit
    /// an unlisted var (e.g. lowercase `nvm_dir`).</summary>
    private static StringComparer KeyComparer =>
        OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    /// <summary>Build the child env from the CURRENT process environment (Windows / fallback path).
    /// Unchanged: still OrdinalIgnoreCase, still reads only the base allowlist from
    /// <see cref="Environment"/>. (Manager vars are irrelevant on the Windows native-PATH path.)</summary>
    public static Dictionary<string, string> BuildAllowlisted()
    {
        var env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var key in Allowlist)
        {
            var value = Environment.GetEnvironmentVariable(key);
            if (value is not null) env[key] = value;
        }
        return env;
    }

    /// <summary>Build the child env from a CAPTURED env block (the login-shell discovery path).
    /// Copies only keys in (base ∪ manager) allowlist, case-sensitively on POSIX. The result is
    /// allowlist-only by construction — an unlisted credential/redirect/node-option var in the
    /// captured block cannot pass through.</summary>
    public static Dictionary<string, string> FilterCaptured(IReadOnlyDictionary<string, string> captured)
    {
        ArgumentNullException.ThrowIfNull(captured);
        var allowed = new HashSet<string>(Allowlist, KeyComparer);
        allowed.UnionWith(ManagerVarAllowlist);

        var env = new Dictionary<string, string>(KeyComparer);
        foreach (var (k, v) in captured)
        {
            if (allowed.Contains(k)) env[k] = v;
        }
        return env;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliEnvironmentTests`
Expected: PASS (4 tests; the case-sensitive one is skipped on Windows).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCliEnvironment.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCliEnvironmentTests.cs
git commit -m "feat(ai): add manager-var allowlist + TMPDIR + case-sensitive FilterCaptured"
```

---

## Task 3: Persisted state record + JSON state store

**Files:**
- Create: `PRism.AI.ClaudeCode/ClaudeCliStateRecord.cs`
- Create: `PRism.AI.ClaudeCode/JsonClaudeCliStateStore.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/JsonClaudeCliStateStoreTests.cs`

**Interfaces:**
- Consumes: `ClaudeCliEnvironment.FilterCaptured` (Task 2).
- Produces:
  - `sealed record ClaudeCliStateRecord(int SchemaVersion, string Platform, string ExecutablePath, string Path, IReadOnlyDictionary<string,string> ManagerVars, string? CliVersion, DateTimeOffset DiscoveredAt, string DiscoverySource)`.
  - `sealed class JsonClaudeCliStateStore` with `JsonClaudeCliStateStore(string dataDir)`, `ClaudeCliStateRecord? Load()`, `void Save(ClaudeCliStateRecord record)`, `void Delete()`, and `IReadOnlyDictionary<string,string> RebuildEnv(ClaudeCliStateRecord record)` (returns the filtered child env from `Path` + `ManagerVars`).

The store NEVER reads or writes a full env dict — only `Path` + `ManagerVars`. `Load()` returns `null` (not throw) on missing file, JSON parse error, or a `Platform` that does not match the current OS. `Save` writes atomically (temp-file + `File.Move(overwrite:true)`), sets file mode `600` and dir mode `700` on POSIX.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/JsonClaudeCliStateStoreTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class JsonClaudeCliStateStoreTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-clistate-" + Guid.NewGuid().ToString("N"));

    private static ClaudeCliStateRecord SampleRecord() => new(
        SchemaVersion: 1,
        Platform: OperatingSystem.IsWindows() ? "windows" : "unix",
        ExecutablePath: "/Users/x/.local/bin/claude",
        Path: "/Users/x/.local/bin:/usr/bin:/bin",
        ManagerVars: new Dictionary<string, string> { ["VOLTA_HOME"] = "/Users/x/.volta" },
        CliVersion: "2.1.177",
        DiscoveredAt: DateTimeOffset.UtcNow,
        DiscoverySource: "login-shell");

    [Fact]
    public void Save_then_Load_round_trips()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        var rec = SampleRecord();
        store.Save(rec);

        var loaded = store.Load();
        loaded.Should().NotBeNull();
        loaded!.ExecutablePath.Should().Be(rec.ExecutablePath);
        loaded.Path.Should().Be(rec.Path);
        loaded.ManagerVars.Should().ContainKey("VOLTA_HOME");
        loaded.CliVersion.Should().Be("2.1.177");
    }

    [Fact]
    public void Load_returns_null_when_no_file()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        store.Load().Should().BeNull();
    }

    [Fact]
    public void Load_returns_null_on_corrupt_json()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        File.WriteAllText(Path.Combine(_dir, "claude-cli-state.json"), "{ not json");
        store.Load().Should().BeNull();
    }

    [Fact]
    public void Load_returns_null_for_foreign_platform_record()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        var foreign = SampleRecord() with { Platform = "some-other-os" };
        store.Save(foreign);
        store.Load().Should().BeNull();
    }

    [Fact]
    public void RebuildEnv_yields_only_path_and_manager_vars()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        var rec = SampleRecord();
        var env = store.RebuildEnv(rec);

        env["PATH"].Should().Be(rec.Path);
        env.Should().ContainKey("VOLTA_HOME");
        env.Should().NotContainKey("ANTHROPIC_API_KEY");
    }

    [Fact]
    public void Delete_removes_the_record_and_is_idempotent()
    {
        var store = new JsonClaudeCliStateStore(_dir);
        store.Save(SampleRecord());
        store.Load().Should().NotBeNull();

        store.Delete();
        store.Load().Should().BeNull();
        store.Invoking(s => s.Delete()).Should().NotThrow();   // idempotent on a missing file
    }

    [SkippableFact]
    public void State_file_and_dir_are_owner_only_on_posix()
    {
        Skip.If(OperatingSystem.IsWindows(), "POSIX-only file-mode assertion.");
        var store = new JsonClaudeCliStateStore(_dir);
        store.Save(SampleRecord());

#pragma warning disable CA1416 // Guarded by Skip.If(IsWindows).
        var dirMode = File.GetUnixFileMode(_dir);
        var fileMode = File.GetUnixFileMode(Path.Combine(_dir, "claude-cli-state.json"));
#pragma warning restore CA1416
        var groupOrOther = UnixFileMode.GroupRead | UnixFileMode.GroupWrite | UnixFileMode.GroupExecute
                         | UnixFileMode.OtherRead | UnixFileMode.OtherWrite | UnixFileMode.OtherExecute;
        (dirMode & groupOrOther).Should().Be(UnixFileMode.None);
        (fileMode & groupOrOther).Should().Be(UnixFileMode.None);
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter JsonClaudeCliStateStoreTests`
Expected: FAIL — `ClaudeCliStateRecord` / `JsonClaudeCliStateStore` do not exist.

- [ ] **Step 3: Write minimal implementation**

Create `PRism.AI.ClaudeCode/ClaudeCliStateRecord.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>
/// The persisted discovery record. Holds ONLY what is needed to rebuild the allowlisted child env
/// (<see cref="Path"/> + <see cref="ManagerVars"/>) plus diagnostics — never the full captured env,
/// so the on-disk file can never carry a value that was not reviewed for on-disk storage.
/// </summary>
public sealed record ClaudeCliStateRecord(
    int SchemaVersion,
    string Platform,
    string ExecutablePath,
    string Path,
    IReadOnlyDictionary<string, string> ManagerVars,
    string? CliVersion,
    DateTimeOffset DiscoveredAt,
    string DiscoverySource);
```

Create `PRism.AI.ClaudeCode/JsonClaudeCliStateStore.cs`:

```csharp
using System.Text.Json;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Reads/writes the single positive discovery record in the per-user dataDir. Positive-only: the
/// locator never persists a "not found". The file holds <c>path</c> + <c>managerVars</c> (the
/// path-pointing subset) — the full child env is rebuilt from those on load through the same §5
/// filter, so an on-disk value that is not allowlisted for storage is impossible. POSIX: dir 700,
/// file 600; Windows relies on the per-user dataDir's default owner ACL (mirrors
/// <see cref="JsonlTokenUsageTracker"/>).
/// </summary>
public sealed class JsonClaudeCliStateStore
{
    public const int CurrentSchemaVersion = 1;

    /// <summary>The OS family tag written into / matched against <see cref="ClaudeCliStateRecord.Platform"/>.</summary>
    public static string CurrentPlatform => OperatingSystem.IsWindows() ? "windows" : "unix";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _path;

    public JsonClaudeCliStateStore(string dataDir)
    {
        ArgumentException.ThrowIfNullOrEmpty(dataDir);
        Directory.CreateDirectory(dataDir);
        if (!OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(dataDir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        _path = Path.Combine(dataDir, "claude-cli-state.json");
    }

    /// <summary>Returns the record, or <c>null</c> when absent, unparseable, or for a foreign
    /// platform — all of which mean "re-discover", never throw.</summary>
    public ClaudeCliStateRecord? Load()
    {
        if (!File.Exists(_path)) return null;
        try
        {
            var record = JsonSerializer.Deserialize<ClaudeCliStateRecord>(File.ReadAllText(_path), Json);
            if (record is null || record.Platform != CurrentPlatform) return null;
            return record;
        }
        catch (JsonException)
        {
            return null;   // corrupt → re-discover
        }
    }

    /// <summary>Atomic write (temp-file + rename) so a crash or concurrent read never sees a partial
    /// file. The temp file is created with owner-only mode FROM THE OUTSET on POSIX (via
    /// <see cref="UnixFileMode"/> on the open) — NOT written-then-chmod'd — so there is no window in
    /// which it is world-readable under the default umask, and a crash mid-write can't strand a
    /// readable temp file.</summary>
    public void Save(ClaudeCliStateRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        var tmp = _path + ".tmp-" + Guid.NewGuid().ToString("N");
        var json = JsonSerializer.Serialize(record, Json);

        var fileOptions = new FileStreamOptions { Mode = FileMode.CreateNew, Access = FileAccess.Write };
        if (!OperatingSystem.IsWindows())
            fileOptions.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;   // 600 at create time

        using (var stream = new FileStream(tmp, fileOptions))
        using (var writer = new StreamWriter(stream))
        {
            writer.Write(json);
        }
        File.Move(tmp, _path, overwrite: true);
    }

    /// <summary>Discard the persisted record (spec §6 self-heal: "discard the record and
    /// re-discover"). Idempotent — a missing file is not an error.</summary>
    public void Delete()
    {
        if (File.Exists(_path)) File.Delete(_path);
    }

    /// <summary>Rebuild the allowlisted child env from the record's <c>path</c> + <c>managerVars</c>,
    /// through the same filter as live discovery — the full env is never read from disk.</summary>
    public IReadOnlyDictionary<string, string> RebuildEnv(ClaudeCliStateRecord record)
    {
        ArgumentNullException.ThrowIfNull(record);
        var captured = new Dictionary<string, string>(
            OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal)
        {
            ["PATH"] = record.Path,
        };
        foreach (var (k, v) in record.ManagerVars) captured[k] = v;
        return ClaudeCliEnvironment.FilterCaptured(captured);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter JsonClaudeCliStateStoreTests`
Expected: PASS (6 tests; the POSIX file-mode one is skipped on Windows).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCliStateRecord.cs PRism.AI.ClaudeCode/JsonClaudeCliStateStore.cs tests/PRism.AI.ClaudeCode.Tests/JsonClaudeCliStateStoreTests.cs
git commit -m "feat(ai): add positive-only JSON state store (atomic, owner-only, env rebuilt on load)"
```

---

## Task 4: Login-shell capture seam + sentinel parser

**Files:**
- Create: `PRism.AI.ClaudeCode/LoginShellCapture.cs`
- Create: `PRism.AI.ClaudeCode/ILoginShellEnvironmentReader.cs`
- Create: `PRism.AI.ClaudeCode/SystemLoginShellEnvironmentReader.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/LoginShellCaptureParseTests.cs`

**Interfaces:**
- Produces:
  - `sealed record LoginShellCapture(IReadOnlyDictionary<string,string> Environment, string? CommandVClaude)`.
  - `interface ILoginShellEnvironmentReader { Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct); }`.
  - `sealed class SystemLoginShellEnvironmentReader : ILoginShellEnvironmentReader` (real shell spawn — **manual P1, not CI**), exposing `internal static LoginShellCapture? ParseCapture(string stdout, string s1, string s2, string s3)` for direct unit testing of the parse logic.

The parser's contract: the snippet prints `s1`, then the `command -v claude` line, then `s2`, then the full `env` block, then `s3`. `ParseCapture` extracts the `command -v claude` text between `s1` and `s2` (null if empty/missing), and the `KEY=VALUE` env lines between `s2` and `s3`. Banner/MOTD noise before `s1` or after `s3`, or a stray fixed marker in an rc file, must not corrupt the parse. Returns `null` if the sentinels are missing/out of order (garbled capture → no candidate).

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/LoginShellCaptureParseTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class LoginShellCaptureParseTests
{
    private const string S1 = "S1-aaa";
    private const string S2 = "S2-bbb";
    private const string S3 = "S3-ccc";

    private static string Wrap(string commandV, string envBlock, string banner = "") =>
        $"{banner}{S1}\n{commandV}\n{S2}\n{envBlock}\n{S3}\n";

    [Fact]
    public void Parses_command_v_and_env_block()
    {
        var stdout = Wrap(
            commandV: "/opt/homebrew/bin/claude",
            envBlock: "PATH=/opt/homebrew/bin:/usr/bin\nHOME=/Users/x\nVOLTA_HOME=/Users/x/.volta");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().Be("/opt/homebrew/bin/claude");
        cap.Environment["PATH"].Should().Be("/opt/homebrew/bin:/usr/bin");
        cap.Environment["VOLTA_HOME"].Should().Be("/Users/x/.volta");
    }

    [Fact]
    public void Ignores_banner_noise_before_first_sentinel()
    {
        var stdout = Wrap(
            commandV: "/usr/local/bin/claude",
            envBlock: "PATH=/usr/local/bin",
            banner: "Welcome to zsh!\nLast login: yesterday\n");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().Be("/usr/local/bin/claude");
    }

    [Fact]
    public void Null_command_v_when_claude_not_found()
    {
        var stdout = Wrap(commandV: "", envBlock: "PATH=/usr/bin");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().NotBeNull();
        cap!.CommandVClaude.Should().BeNull();
        cap.Environment.Should().ContainKey("PATH");
    }

    [Fact]
    public void Returns_null_when_sentinels_missing()
    {
        var stdout = "no sentinels here at all\nPATH=/usr/bin\n";

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap.Should().BeNull();
    }

    [Fact]
    public void Env_value_may_contain_equals_sign()
    {
        var stdout = Wrap(
            commandV: "/usr/bin/claude",
            envBlock: "PATH=/usr/bin\nLS_COLORS=di=34:ln=35");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap!.Environment["LS_COLORS"].Should().Be("di=34:ln=35");
    }

    [Fact]
    public void Rejects_interleaved_non_env_lines_in_env_block()
    {
        // A prompt-framework status line / escape sequence with '=' interleaved in the env region
        // must not inject a key or corrupt PATH.
        var stdout = Wrap(
            commandV: "/usr/bin/claude",
            envBlock: "PATH=/usr/bin\n[1;32m status here=bogus\nVOLTA_HOME=/v");

        var cap = SystemLoginShellEnvironmentReader.ParseCapture(stdout, S1, S2, S3);

        cap!.Environment["PATH"].Should().Be("/usr/bin");
        cap.Environment["VOLTA_HOME"].Should().Be("/v");
        cap.Environment.Should().HaveCount(2);   // the escape-prefixed line is dropped
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter LoginShellCaptureParseTests`
Expected: FAIL — `SystemLoginShellEnvironmentReader.ParseCapture` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `PRism.AI.ClaudeCode/LoginShellCapture.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>The result of reproducing the user's login-shell environment: the full captured env
/// block, and the <c>command -v claude</c> result (null when the shell could not resolve it).</summary>
public sealed record LoginShellCapture(
    IReadOnlyDictionary<string, string> Environment,
    string? CommandVClaude);
```

Create `PRism.AI.ClaudeCode/ILoginShellEnvironmentReader.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>Reproduces the user's login-shell environment so both `claude` and the `node` an
/// npm-install needs resolve the way they do in the user's terminal. The ONE seam that touches the
/// login shell; faked in unit tests, exercised for real only in manual P1.</summary>
public interface ILoginShellEnvironmentReader
{
    /// <summary>Spawn <c>$SHELL -ilc</c> with a CLEARED env and capture the reconstructed env +
    /// <c>command -v claude</c>. Returns <c>null</c> on timeout, a non-POSIX shell, or a garbled
    /// capture (caller falls to the degradation ladder).</summary>
    Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct);
}
```

Create `PRism.AI.ClaudeCode/SystemLoginShellEnvironmentReader.cs`:

```csharp
using System.Diagnostics;
using System.Text;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Real login-shell capture. Spawns <c>$SHELL -ilc</c> with a CLEARED env block carrying only the
/// minimum to locate the shell + its rc files (HOME, USER/LOGNAME, TMPDIR) plus three per-invocation
/// random sentinels; the rc files reconstruct the user's full environment from scratch, and that
/// reconstruction IS the signal. The process spawn is validated MANUALLY in P1 (not CI — same posture
/// as <see cref="SystemCliProcessRunner"/>); the pure <see cref="ParseCapture"/> logic is unit-tested.
/// </summary>
public sealed class SystemLoginShellEnvironmentReader : ILoginShellEnvironmentReader
{
    public async Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct)
    {
        if (OperatingSystem.IsWindows()) return null;   // discovery is Unix-only

        var shell = ResolveShell();
        var s1 = "PRISM_S1_" + Guid.NewGuid().ToString("N");
        var s2 = "PRISM_S2_" + Guid.NewGuid().ToString("N");
        var s3 = "PRISM_S3_" + Guid.NewGuid().ToString("N");
        var snippet =
            "printf '%s\\n' \"$S1\"; command -v claude; printf '%s\\n' \"$S2\"; " +
            "/usr/bin/env; printf '%s\\n' \"$S3\"";

        var psi = new ProcessStartInfo
        {
            FileName = shell,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-ilc");
        psi.ArgumentList.Add(snippet);

        psi.Environment.Clear();   // do NOT inherit the sidecar's env into the rc execution
        CopyIfSet(psi, "HOME");
        CopyIfSet(psi, "USER");
        CopyIfSet(psi, "LOGNAME");
        CopyIfSet(psi, "TMPDIR");
        psi.Environment["S1"] = s1;
        psi.Environment["S2"] = s2;
        psi.Environment["S3"] = s3;

        using var process = new Process { StartInfo = psi };
        var stdout = new StringBuilder();
        process.OutputDataReceived += (_, e) => { if (e.Data is not null) stdout.AppendLine(e.Data); };
        process.ErrorDataReceived += (_, e) => { /* rc noise to stderr is discarded */ };

        try
        {
            process.Start();
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;   // shell not launchable → ladder
        }
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        using var timeoutCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeoutCts.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(timeoutCts.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (timeoutCts.IsCancellationRequested && !ct.IsCancellationRequested)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            return null;   // pathological rc hung → ladder
        }
#pragma warning disable CA1849 // sync drain after WaitForExitAsync returns immediately post-exit
        process.WaitForExit();
#pragma warning restore CA1849

        return ParseCapture(stdout.ToString(), s1, s2, s3);
    }

    private static string ResolveShell()
    {
        var shell = Environment.GetEnvironmentVariable("SHELL");
        if (!string.IsNullOrEmpty(shell) && File.Exists(shell)) return shell;
        foreach (var candidate in new[] { "/bin/zsh", "/bin/bash", "/bin/sh" })
            if (File.Exists(candidate)) return candidate;
        return "/bin/sh";
    }

    private static void CopyIfSet(ProcessStartInfo psi, string key)
    {
        var value = Environment.GetEnvironmentVariable(key);
        if (value is not null) psi.Environment[key] = value;
    }

    /// <summary>Pure parse of the snippet's stdout. Extracts the <c>command -v claude</c> line
    /// between <paramref name="s1"/> and <paramref name="s2"/> and the <c>KEY=VALUE</c> env lines
    /// between <paramref name="s2"/> and <paramref name="s3"/>. Banner/MOTD noise outside the
    /// sentinel-delimited regions is ignored. Returns <c>null</c> when the sentinels are missing or
    /// out of order.</summary>
    internal static LoginShellCapture? ParseCapture(string stdout, string s1, string s2, string s3)
    {
        var lines = stdout.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        int i1 = Array.IndexOf(lines, s1);
        int i2 = Array.IndexOf(lines, s2);
        int i3 = Array.IndexOf(lines, s3);
        if (i1 < 0 || i2 <= i1 || i3 <= i2) return null;

        // command -v claude: the (single) non-empty line between s1 and s2.
        string? commandV = null;
        for (var i = i1 + 1; i < i2; i++)
        {
            if (!string.IsNullOrWhiteSpace(lines[i])) { commandV = lines[i].Trim(); break; }
        }

        var env = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = i2 + 1; i < i3; i++)
        {
            var line = lines[i];
            var eq = line.IndexOf('=', StringComparison.Ordinal);
            if (eq <= 0) continue;                       // not a KEY=VALUE line
            var key = line[..eq];
            // Require a valid POSIX env-var NAME before '='. This rejects interleaved rc output that
            // happens to contain '=' — a prompt-framework status line, a `clear` escape sequence, a
            // colorized banner — from injecting a bogus key or corrupting PATH (spec §8 / P1 noise).
            if (!IsValidEnvKey(key)) continue;
            env[key] = line[(eq + 1)..];                 // value may contain '='
        }

        return new LoginShellCapture(env, commandV);
    }

    private static bool IsValidEnvKey(string key)
    {
        if (key.Length == 0) return false;
        if (!(char.IsAsciiLetter(key[0]) || key[0] == '_')) return false;
        foreach (var c in key)
            if (!(char.IsAsciiLetterOrDigit(c) || c == '_')) return false;
        return true;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter LoginShellCaptureParseTests`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/LoginShellCapture.cs PRism.AI.ClaudeCode/ILoginShellEnvironmentReader.cs PRism.AI.ClaudeCode/SystemLoginShellEnvironmentReader.cs tests/PRism.AI.ClaudeCode.Tests/LoginShellCaptureParseTests.cs
git commit -m "feat(ai): add login-shell env reader + sentinel-delimited capture parser"
```

---

## Task 5: Locator core — identity, Windows no-op, single-flight, snapshot, invalidate

**Files:**
- Create: `PRism.AI.ClaudeCode/IClaudeCliLocator.cs`
- Create: `PRism.AI.ClaudeCode/ClaudeCliLocator.cs`
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs`
- Create: `tests/PRism.AI.ClaudeCode.Tests/FakeLoginShellEnvironmentReader.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs`

**Interfaces:**
- Consumes: `ILoginShellEnvironmentReader` (Task 4), `JsonClaudeCliStateStore` (Task 3), `ICliProcessRunner` + `ProcessSpec` + `ProcessResult` (existing), `ClaudeCodeProviderOptions` (existing), `ClaudeCliEnvironment.BuildAllowlisted` (existing), `ResolvedCli`/`NotFound` (Task 1).
- Produces:
  - `interface IClaudeCliLocator { Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct); ClaudeCliResolution? CurrentResolved { get; } void InvalidateResolved(); }`.
  - `sealed class ClaudeCliLocator(ILoginShellEnvironmentReader reader, JsonClaudeCliStateStore store, ICliProcessRunner runner, ClaudeCodeProviderOptions options, Func<bool> identityMatches, TimeProvider clock, Func<string,bool>? pathExists = null) : IClaudeCliLocator`.
  - `ClaudeCodeProviderOptions.DiscoveryTimeout` (`TimeSpan`, default 10s) and `ClaudeCodeProviderOptions.NegativeTtl` (`TimeSpan`, default 30s).

This task implements the orchestration *shell*: identity short-circuit (every call, no cache), Windows no-op, the `SemaphoreSlim(1,1)` single-flight + double-check, `CurrentResolved` (sync snapshot of the last positive), and `InvalidateResolved`. Cold discovery (Task 6) and warm reuse/self-heal (Task 7) fill in the Unix slow path; here that slow path is a single private `DiscoverUnixAsync` stub returning `NotFound(CliDiscoveryFailed)` so the shell is testable in isolation.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.AI.ClaudeCode.Tests/FakeLoginShellEnvironmentReader.cs`:

```csharp
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

/// <summary>Returns a canned <see cref="LoginShellCapture"/> (or null), and counts calls so a test
/// can assert single-flight (one capture under concurrent callers).</summary>
public sealed class FakeLoginShellEnvironmentReader : ILoginShellEnvironmentReader
{
    private readonly LoginShellCapture? _capture;
    public int CallCount { get; private set; }

    public FakeLoginShellEnvironmentReader(LoginShellCapture? capture) => _capture = capture;

    public Task<LoginShellCapture?> CaptureAsync(TimeSpan timeout, CancellationToken ct)
    {
        CallCount++;
        return Task.FromResult(_capture);
    }
}
```

Create `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs`:

```csharp
using FluentAssertions;
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCliLocatorTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "prism-locator-" + Guid.NewGuid().ToString("N"));

    private ClaudeCliLocator Build(
        LoginShellCapture? capture = null,
        ProcessResult? versionResult = null,
        bool identity = true,
        Func<string, bool>? pathExists = null,
        FakeLoginShellEnvironmentReader? reader = null)
    {
        reader ??= new FakeLoginShellEnvironmentReader(capture);
        var runner = new FakeCliProcessRunner(versionResult ?? new ProcessResult(0, "2.1.177", "", false));
        return new ClaudeCliLocator(
            reader,
            new JsonClaudeCliStateStore(_dir),
            runner,
            new ClaudeCodeProviderOptions { WorkingDirectory = _dir },
            identityMatches: () => identity,
            clock: TimeProvider.System,
            pathExists: pathExists ?? (_ => true));
    }

    [Fact]
    public async Task Identity_mismatch_returns_NotFound_without_discovery()
    {
        var reader = new FakeLoginShellEnvironmentReader(null);
        var locator = Build(identity: false, reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
        reader.CallCount.Should().Be(0);
    }

    [SkippableFact]
    public async Task Windows_returns_inherited_invocation_without_discovery()
    {
        Skip.IfNot(OperatingSystem.IsWindows(), "Windows-only no-op path.");
        var reader = new FakeLoginShellEnvironmentReader(null);
        var locator = Build(reader: reader);

        var res = await locator.ResolveAsync(CancellationToken.None);

        var resolved = res.Should().BeOfType<ResolvedCli>().Subject;
        resolved.ExecutablePath.Should().Be("claude");
        resolved.Environment.Should().ContainKey("PATH");
        reader.CallCount.Should().Be(0);
    }

    [Fact]
    public async Task CurrentResolved_is_null_before_first_resolve()
    {
        var locator = Build();
        locator.CurrentResolved.Should().BeNull();
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir)) Directory.Delete(_dir, recursive: true);
        GC.SuppressFinalize(this);
    }
}
```

> The single-flight test lives in Task 6 (not here): it exercises the cold-discovery path, which is still a stub in this task. Task 5's three tests all pass against the stub.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: FAIL — `IClaudeCliLocator` / `ClaudeCliLocator` do not exist; `ClaudeCodeProviderOptions` has no `DiscoveryTimeout`/`NegativeTtl`.

- [ ] **Step 3: Write minimal implementation**

Modify `PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs` — add two properties after `ProbeTimeout`:

```csharp
    /// <summary>Wall-clock ceiling for the login-shell discovery capture (spec §4.2). Separate from
    /// <see cref="ProbeTimeout"/>; a timeout falls to the degradation ladder.</summary>
    public TimeSpan DiscoveryTimeout { get; init; } = TimeSpan.FromSeconds(10);

    /// <summary>In-memory TTL for a discovery NEGATIVE result (spec §6). Never persisted; a restart
    /// or a mid-session install recovers within this window.</summary>
    public TimeSpan NegativeTtl { get; init; } = TimeSpan.FromSeconds(30);
```

Create `PRism.AI.ClaudeCode/IClaudeCliLocator.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>
/// Resolves the `claude` CLI to a launchable <see cref="ResolvedCli"/> (or a <see cref="NotFound"/>).
/// Discover-once-persist-reuse with self-heal (spec §6); single-flighted + memoized. On Windows it is
/// an exact no-op returning the inherited bare-name invocation.
/// </summary>
public interface IClaudeCliLocator
{
    /// <summary>Resolve, running discovery at most once per cold state. Memoized: a positive result
    /// is sticky until <see cref="InvalidateResolved"/>; a negative result is in-memory TTL only.</summary>
    Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct);

    /// <summary>The last positive resolution, or <c>null</c> if none yet. A NON-BLOCKING snapshot for
    /// the synchronous streaming provider, which cannot await (spec §3.2).</summary>
    ClaudeCliResolution? CurrentResolved { get; }

    /// <summary>Self-heal seam (spec §6): a spawn site that hit an executable-not-found signature
    /// under the resolved env calls this so the next <see cref="ResolveAsync"/> re-discovers.</summary>
    void InvalidateResolved();
}
```

Create `PRism.AI.ClaudeCode/ClaudeCliLocator.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>
/// Owns CLI resolution + persistence + self-heal (spec §§3–7). Single-flighted by a
/// <see cref="SemaphoreSlim"/>(1,1) with double-check (mirrors <c>CachedLlmAvailabilityProbe</c>) so
/// the eager Live-entry trigger and any concurrent probe never spawn N login shells.
/// </summary>
public sealed class ClaudeCliLocator : IClaudeCliLocator
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

    // Filled in by Tasks 6 (cold discovery + ladder) and 7 (warm reuse + self-heal). For now the
    // shell has no Unix resolution path.
    private Task<ClaudeCliResolution> ResolveUnixAsync(CancellationToken ct) =>
        Task.FromResult<ClaudeCliResolution>(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: PASS. `Identity_mismatch…` and `CurrentResolved_is_null…` run on every OS; `Windows_returns_inherited_invocation…` runs only on Windows (skipped elsewhere). The single-flight + cold-discovery tests live in Task 6.

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/IClaudeCliLocator.cs PRism.AI.ClaudeCode/ClaudeCliLocator.cs PRism.AI.ClaudeCode/ClaudeCodeProviderOptions.cs tests/PRism.AI.ClaudeCode.Tests/FakeLoginShellEnvironmentReader.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs
git commit -m "feat(ai): add ClaudeCliLocator shell — identity, Windows no-op, single-flight, snapshot"
```

---

## Task 6: Locator cold discovery — both topologies, exec-validation, persist, ladder

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCliLocator.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs` (add cases)

**Interfaces:**
- Consumes: everything from Task 5 plus `ClaudeCliEnvironment.FilterCaptured`, `JsonClaudeCliStateStore.Save`, `ClaudeCliStateRecord`.
- Produces: a working `ResolveUnixAsync` cold path — capture login shell → pick candidate → exec-validate `claude --version` → persist + `ResolvedCli`; on capture failure or no working candidate, walk the degradation ladder (`~/.local/bin`, `/opt/homebrew/bin`, `/usr/local/bin`), each exec-validated; `NotFound(CliDiscoveryFailed)` if nothing validates. Adds a private `RunVersionAsync(string path, IReadOnlyDictionary<string,string> env, CancellationToken) → ProcessResult?` helper (null on `Win32Exception`).

Candidate selection (spec §4.3): use `capture.CommandVClaude` **only if it is an absolute path to an existing file**; otherwise resolve `claude` against the captured `PATH`. A non-path `command -v` result (alias/function/builtin) yields no candidate from the capture (fall to ladder).

- [ ] **Step 1: Write the failing test**

Add to `ClaudeCliLocatorTests.cs` (and remove the Task-5 skip on `Single_flight…` if you added one):

```csharp
    [SkippableFact]
    public async Task Cold_discovery_native_topology_resolves_and_persists()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/Users/x/.local/bin:/usr/bin", ["HOME"] = "/Users/x" },
            CommandVClaude: "/Users/x/.local/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/Users/x/.local/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        var ok = res.Should().BeOfType<ResolvedCli>().Subject;
        ok.ExecutablePath.Should().Be("/Users/x/.local/bin/claude");
        ok.Environment["PATH"].Should().Be("/Users/x/.local/bin:/usr/bin");

        // Persisted positive record is reloadable.
        new JsonClaudeCliStateStore(_dir).Load().Should().NotBeNull();
    }

    [SkippableFact]
    public async Task Cold_discovery_npm_topology_keeps_manager_vars()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string>
            {
                ["PATH"] = "/Users/x/.volta/bin:/usr/bin",
                ["VOLTA_HOME"] = "/Users/x/.volta",
            },
            CommandVClaude: "/Users/x/.volta/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/Users/x/.volta/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>()
            .Which.Environment.Should().ContainKey("VOLTA_HOME");
    }

    [SkippableFact]
    public async Task Non_path_command_v_falls_through_to_ladder()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        // command -v resolves to a shell function/alias name, not a path → no candidate from capture.
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/usr/bin" },
            CommandVClaude: "claude: aliased to claude --foo");
        // The ladder finds /opt/homebrew/bin/claude on disk and it validates.
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/opt/homebrew/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        var ok = res.Should().BeOfType<ResolvedCli>().Subject;
        ok.ExecutablePath.Should().Be("/opt/homebrew/bin/claude");
        // Spec §4.5: a ladder candidate runs under the MINIMAL base allowlist (native topology, no
        // node), NOT the captured login-shell env — assert no manager var rode along.
        ok.Environment.Keys.Should().OnlyContain(k => ClaudeCliEnvironment.Allowlist.Contains(k));
    }

    [SkippableFact]
    public async Task Capture_failure_falls_back_to_ladder()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture: null),
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/usr/local/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>().Which.ExecutablePath.Should().Be("/usr/local/bin/claude");
    }

    [SkippableFact]
    public async Task Nothing_found_returns_CliDiscoveryFailed()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture: null),
            pathExists: _ => false);

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [SkippableFact]
    public async Task Candidate_that_fails_version_exec_is_rejected()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        // Capture points at a claude whose `node` is gone → --version exits non-zero. No ladder hit either.
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/Users/x/.volta/bin" },
            CommandVClaude: "/Users/x/.volta/bin/claude");
        var locator = Build(reader: new FakeLoginShellEnvironmentReader(capture),
            versionResult: new ProcessResult(127, "", "env: node: No such file or directory", false),
            pathExists: p => p == "/Users/x/.volta/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<NotFound>().Which.ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [SkippableFact]
    public async Task Single_flight_runs_discovery_once_under_concurrent_callers()
    {
        Skip.If(OperatingSystem.IsWindows(), "Exercises the Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/opt/homebrew/bin" },
            CommandVClaude: "/opt/homebrew/bin/claude");
        var reader = new FakeLoginShellEnvironmentReader(capture);
        var locator = Build(reader: reader,
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/opt/homebrew/bin/claude");

        await Task.WhenAll(Enumerable.Range(0, 8).Select(_ => locator.ResolveAsync(CancellationToken.None)));

        reader.CallCount.Should().Be(1);   // the gate dedups concurrent callers to one capture
    }
```

> The `FakeCliProcessRunner` returns the same canned `versionResult` for every spawn, so a ladder probe and a capture-candidate probe both see it. The `pathExists` predicate is what differentiates which candidate "exists"; the runner's result decides whether it validates. That's sufficient to drive every branch above.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: FAIL — `ResolveUnixAsync` still returns `CliDiscoveryFailed` unconditionally; the positive cases fail.

- [ ] **Step 3: Write minimal implementation**

Replace the `ResolveUnixAsync` stub in `ClaudeCliLocator.cs` with the cold-discovery path (Task 7 will prepend the warm-record check):

```csharp
    private static readonly string[] LadderRelativeToHome =
        [".local/bin/claude"];
    private static readonly string[] LadderAbsolute =
        ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

    private async Task<ClaudeCliResolution> ResolveUnixAsync(CancellationToken ct)
    {
        // (Task 7 inserts the persisted-record warm-reuse check here.)
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
    private string? PickCandidate(LoginShellCapture capture, IReadOnlyDictionary<string, string> env)
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
        string executablePath, IReadOnlyDictionary<string, string> env, string versionStdout, string source)
    {
        var managerVars = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var key in ClaudeCliEnvironment.ManagerVarAllowlist)
            if (env.TryGetValue(key, out var v)) managerVars[key] = v;

        env.TryGetValue("PATH", out var pathValue);
        _store.Save(new ClaudeCliStateRecord(
            SchemaVersion: JsonClaudeCliStateStore.CurrentSchemaVersion,
            Platform: JsonClaudeCliStateStore.CurrentPlatform,
            ExecutablePath: executablePath,
            Path: pathValue ?? string.Empty,
            ManagerVars: managerVars,
            CliVersion: versionStdout.Trim() is { Length: > 0 } v ? v : null,
            DiscoveredAt: _clock.GetUtcNow(),
            DiscoverySource: source));

        return new ResolvedCli(executablePath, env);
    }
```

Add `using System.ComponentModel;` is not required (fully-qualified above); keep the file's existing usings.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: PASS (cold-discovery + ladder + single-flight cases; Windows skips the Unix ones).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCliLocator.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs
git commit -m "feat(ai): locator cold discovery — candidate pick, exec-validate, persist, ladder"
```

---

## Task 7: Locator warm reuse + self-heal + negative TTL

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCliLocator.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs` (add cases)

**Interfaces:**
- Consumes: everything from Task 6 plus `JsonClaudeCliStateStore.Load` / `RebuildEnv`.
- Produces: `ResolveUnixAsync` first tries the persisted record (platform already matched by `Load()`; reuse iff `_pathExists(record.ExecutablePath)`), rebuilding the env via `RebuildEnv` — **no spawn on the warm path**. Self-heal: a vanished path falls through to cold discovery. `InvalidateResolved` (Task 5) + the negative TTL (Task 5) already cover the exec-not-found and recovery cases; this task adds the warm-reuse and warm-path-vanished tests plus the negative-TTL-expiry test.

- [ ] **Step 1: Write the failing test**

Add to `ClaudeCliLocatorTests.cs`:

```csharp
    [SkippableFact]
    public async Task Warm_record_is_reused_without_discovery()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        // Seed a positive record.
        new JsonClaudeCliStateStore(_dir).Save(new ClaudeCliStateRecord(
            1, "unix", "/Users/x/.local/bin/claude", "/Users/x/.local/bin:/usr/bin",
            new Dictionary<string, string>(), "2.1.177", DateTimeOffset.UtcNow, "login-shell"));

        var reader = new FakeLoginShellEnvironmentReader(null);   // would yield nothing if called
        var locator = Build(reader: reader, pathExists: p => p == "/Users/x/.local/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>().Which.ExecutablePath.Should().Be("/Users/x/.local/bin/claude");
        reader.CallCount.Should().Be(0);   // warm reuse — no login shell spawned
    }

    [SkippableFact]
    public async Task Warm_record_with_vanished_path_triggers_rediscovery()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        new JsonClaudeCliStateStore(_dir).Save(new ClaudeCliStateRecord(
            1, "unix", "/Users/x/.local/bin/claude", "/Users/x/.local/bin", // this path will report "gone"
            new Dictionary<string, string>(), "2.1.177", DateTimeOffset.UtcNow, "login-shell"));

        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/opt/homebrew/bin" },
            CommandVClaude: "/opt/homebrew/bin/claude");
        var reader = new FakeLoginShellEnvironmentReader(capture);
        var locator = Build(reader: reader,
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            // old path gone; the newly-discovered one exists
            pathExists: p => p == "/opt/homebrew/bin/claude");

        var res = await locator.ResolveAsync(CancellationToken.None);

        res.Should().BeOfType<ResolvedCli>().Which.ExecutablePath.Should().Be("/opt/homebrew/bin/claude");
        reader.CallCount.Should().Be(1);   // re-discovered
    }

    [SkippableFact]
    public async Task Invalidate_forces_rediscovery_on_next_resolve()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var capture = new LoginShellCapture(
            new Dictionary<string, string> { ["PATH"] = "/opt/homebrew/bin" },
            CommandVClaude: "/opt/homebrew/bin/claude");
        var reader = new FakeLoginShellEnvironmentReader(capture);
        var locator = Build(reader: reader,
            versionResult: new ProcessResult(0, "2.1.177", "", false),
            pathExists: p => p == "/opt/homebrew/bin/claude");

        await locator.ResolveAsync(CancellationToken.None);
        reader.CallCount.Should().Be(1);

        locator.InvalidateResolved();
        await locator.ResolveAsync(CancellationToken.None);

        reader.CallCount.Should().Be(2);   // invalidation cleared the sticky positive AND the disk record
    }

    [SkippableFact]
    public async Task Invalidate_discards_record_so_a_present_but_broken_path_is_not_reserved()
    {
        // Regression for the self-heal loop: a present-but-broken npm shim (node removed). Without
        // discarding the disk record, every resolve would reload the dead path from the warm cache and
        // re-serve it, defeating the negative-TTL backoff. After invalidate the record is gone, so the
        // next resolve goes COLD, finds nothing launchable, and backs off to NotFound — not the shim.
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var store = new JsonClaudeCliStateStore(_dir);
        store.Save(new ClaudeCliStateRecord(
            1, "unix", "/Users/x/.volta/bin/claude", "/Users/x/.volta/bin",
            new Dictionary<string, string>(), "2.1.177", DateTimeOffset.UtcNow, "login-shell"));

        var reader = new FakeLoginShellEnvironmentReader(capture: null);   // cold re-discovery finds nothing
        var locator = Build(reader: reader, pathExists: p => p == "/Users/x/.volta/bin/claude");

        // Warm reuse of the still-present shim path — no discovery spawn.
        (await locator.ResolveAsync(CancellationToken.None)).Should().BeOfType<ResolvedCli>();
        reader.CallCount.Should().Be(0);

        locator.InvalidateResolved();                 // provider's exec-not-found self-heal fires
        store.Load().Should().BeNull();               // record discarded

        // Next resolve does NOT re-serve the dead shim — it re-discovers (cold) and backs off.
        (await locator.ResolveAsync(CancellationToken.None)).Should().BeOfType<NotFound>();
    }

    [SkippableFact]
    public async Task Negative_result_expires_after_ttl()
    {
        Skip.If(OperatingSystem.IsWindows(), "Unix discovery path.");
        var clock = new Microsoft.Extensions.Time.Testing.FakeTimeProvider();
        var reader = new FakeLoginShellEnvironmentReader(capture: null);
        var locator = new ClaudeCliLocator(
            reader, new JsonClaudeCliStateStore(_dir),
            new FakeCliProcessRunner(new ProcessResult(0, "2.1.177", "", false)),
            new ClaudeCodeProviderOptions { WorkingDirectory = _dir, NegativeTtl = TimeSpan.FromSeconds(30) },
            identityMatches: () => true, clock: clock, pathExists: _ => false);

        (await locator.ResolveAsync(CancellationToken.None)).Should().BeOfType<NotFound>();
        reader.CallCount.Should().Be(1);

        // Within TTL: served from the negative cache, no re-discovery.
        await locator.ResolveAsync(CancellationToken.None);
        reader.CallCount.Should().Be(1);

        // Past TTL: re-discovers.
        clock.Advance(TimeSpan.FromSeconds(31));
        await locator.ResolveAsync(CancellationToken.None);
        reader.CallCount.Should().Be(2);
    }
```

> `FakeTimeProvider` is in `Microsoft.Extensions.TimeProvider.Testing`. `PRism.AI.ClaudeCode.Tests` does not yet reference it, but **this repo uses central package management** — `Directory.Packages.props` already pins the package at `10.0.0` (and `PRism.Core.Tests` already consumes it version-less). So add a **version-less** entry to `tests/PRism.AI.ClaudeCode.Tests/PRism.AI.ClaudeCode.Tests.csproj`: `<PackageReference Include="Microsoft.Extensions.TimeProvider.Testing" />`. Do NOT run `dotnet add package` — under CPM it writes a `Version=` attribute and fails the build with NU1008.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: FAIL — warm reuse not implemented (`Warm_record_is_reused…` re-discovers / returns wrong path).

- [ ] **Step 3: Write minimal implementation**

In `ClaudeCliLocator.cs`, replace the `ResolveUnixAsync` body (the Task-6 placeholder comment) with the warm-path check ahead of cold discovery:

```csharp
    private async Task<ClaudeCliResolution> ResolveUnixAsync(CancellationToken ct)
    {
        // Warm path: a persisted positive record is reused iff its executable still exists. NO spawn
        // here — the node-manager-swap case (shim present, pinned node gone) is caught lazily when the
        // next real spawn hits exec-not-found and calls InvalidateResolved (spec §6). Load() has
        // already rejected a foreign-platform record.
        var record = _store.Load();
        if (record is not null && _pathExists(record.ExecutablePath))
            return new ResolvedCli(record.ExecutablePath, (IReadOnlyDictionary<string, string>)_store.RebuildEnv(record));

        return await DiscoverColdAsync(ct).ConfigureAwait(false);
    }
```

(The `RebuildEnv` return is already `IReadOnlyDictionary<string,string>`; the cast is redundant if so — drop it if the compiler flags it.)

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCliLocatorTests`
Expected: PASS (all locator cases; Windows skips the Unix ones).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCliLocator.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCliLocatorTests.cs
git commit -m "feat(ai): locator warm-record reuse + self-heal + negative-TTL expiry"
```

---

## Task 8: Wire one-shot provider + availability probe to the locator

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeAvailabilityProbe.cs`
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs`
- Modify: `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeAvailabilityProbeTests.cs` (rewrite), `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeLlmProviderTests.cs` (adjust)

**Interfaces:**
- Consumes: `IClaudeCliLocator.ResolveAsync` / `InvalidateResolved` (Task 5), `ResolvedCli`/`NotFound` (Task 1).
- Produces:
  - `ClaudeCodeAvailabilityProbe(ICliProcessRunner runner, ClaudeCodeProviderOptions options, IClaudeCliLocator locator)` — identity now lives in the locator; the probe maps `NotFound(reasonCode)` directly, and on a `ResolvedCli` runs `--version` with the resolved invocation, calling `locator.InvalidateResolved()` on a `Win32Exception` or an exec-not-found stderr signature.
  - `ClaudeCodeLlmProvider(ICliProcessRunner runner, ClaudeCodeProviderOptions options, IClaudeCliLocator locator)` — builds the spec from the resolved invocation; throws `LlmProviderException` on `NotFound`; calls `locator.InvalidateResolved()` on `Win32Exception` / exec-not-found before throwing.
  - DI: `AddPrismClaudeCode` registers `ILoginShellEnvironmentReader` → `SystemLoginShellEnvironmentReader`, `JsonClaudeCliStateStore` (constructed with a discovery-state dir under the dataDir), and `IClaudeCliLocator` → `ClaudeCliLocator`; the probe + provider take the locator.

The exec-not-found signature helper (shared shape, defined once in the provider and reused by the probe via a small internal static): stderr contains `"No such file"` together with `"node"`, OR `"env: node"`. Keep it conservative.

- [ ] **Step 1: Write the failing test**

Rewrite `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeAvailabilityProbeTests.cs` to drive the probe through a fake locator. Add a fake locator first:

Create `tests/PRism.AI.ClaudeCode.Tests/FakeClaudeCliLocator.cs`:

```csharp
using PRism.AI.ClaudeCode;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class FakeClaudeCliLocator : IClaudeCliLocator
{
    private readonly ClaudeCliResolution _resolution;
    public int InvalidateCount { get; private set; }

    public FakeClaudeCliLocator(ClaudeCliResolution resolution) => _resolution = resolution;

    public Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct) => Task.FromResult(_resolution);
    public ClaudeCliResolution? CurrentResolved => _resolution as ResolvedCli;
    public void InvalidateResolved() => InvalidateCount++;
}
```

Rewrite `ClaudeCodeAvailabilityProbeTests.cs`:

```csharp
using System.ComponentModel;
using FluentAssertions;
using PRism.AI.ClaudeCode;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode.Tests;

public sealed class ClaudeCodeAvailabilityProbeTests
{
    private static readonly IReadOnlyDictionary<string, string> Env =
        new Dictionary<string, string> { ["PATH"] = "/usr/bin" };

    private static ClaudeCodeAvailabilityProbe Build(
        ProcessResult versionResult, ClaudeCliResolution? resolution = null, FakeCliProcessRunner? runner = null)
    {
        resolution ??= new ResolvedCli("/usr/bin/claude", Env);
        return new ClaudeCodeAvailabilityProbe(
            runner ?? new FakeCliProcessRunner(versionResult),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" },
            new FakeClaudeCliLocator(resolution));
    }

    [Fact]
    public async Task Reports_available_when_version_succeeds()
    {
        var probe = Build(new ProcessResult(0, "2.1.150", "", false));
        (await probe.ProbeAsync(CancellationToken.None)).Should().Be(LlmAvailability.Ok);
    }

    [Fact]
    public async Task Maps_locator_NotFound_cli_not_installed()
    {
        var probe = Build(new ProcessResult(0, "", "", false),
            resolution: new NotFound(ClaudeReasonCodes.CliNotInstalled));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
    }

    [Fact]
    public async Task Maps_locator_NotFound_discovery_failed()
    {
        var probe = Build(new ProcessResult(0, "", "", false),
            resolution: new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.CliDiscoveryFailed);
    }

    [Fact]
    public async Task Maps_locator_NotFound_identity_mismatch_without_probing()
    {
        var runner = new FakeCliProcessRunner(new ProcessResult(0, "2.1.150", "", false));
        var probe = Build(new ProcessResult(0, "2.1.150", "", false),
            resolution: new NotFound(ClaudeReasonCodes.IdentityMismatch), runner: runner);
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.IdentityMismatch);
        runner.Captured.Should().BeNull();   // no --version spawn on a NotFound
    }

    [Fact]
    public async Task Reports_not_logged_in_from_version_output()
    {
        var probe = Build(new ProcessResult(1, "", "Not logged in · Please run /login", false));
        (await probe.ProbeAsync(CancellationToken.None)).ReasonCode.Should().Be(ClaudeReasonCodes.NotLoggedIn);
    }

    [Fact]
    public async Task Invalidates_locator_when_version_throws_win32()
    {
        var locator = new FakeClaudeCliLocator(new ResolvedCli("/usr/bin/claude", Env));
        var probe = new ClaudeCodeAvailabilityProbe(
            new FakeCliProcessRunner(new Win32Exception("The system cannot find the file specified")),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" }, locator);

        var result = await probe.ProbeAsync(CancellationToken.None);

        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
        locator.InvalidateCount.Should().Be(1);   // self-heal: re-discover next time
    }

    [Fact]
    public async Task Invalidates_locator_on_node_not_found_signature()
    {
        var locator = new FakeClaudeCliLocator(new ResolvedCli("/usr/bin/claude", Env));
        var probe = new ClaudeCodeAvailabilityProbe(
            new FakeCliProcessRunner(new ProcessResult(127, "", "env: node: No such file or directory", false)),
            new ClaudeCodeProviderOptions { WorkingDirectory = @"C:\tmp" }, locator);

        var result = await probe.ProbeAsync(CancellationToken.None);

        result.ReasonCode.Should().Be(ClaudeReasonCodes.CliNotInstalled);
        locator.InvalidateCount.Should().Be(1);
    }
}
```

Adjust `ClaudeCodeLlmProviderTests.cs`: the provider constructor gains a locator. Update the test's provider construction helper to pass `new FakeClaudeCliLocator(new ResolvedCli("claude", ClaudeCliEnvironment.BuildAllowlisted()))` (or a minimal env), and keep existing spec assertions — they should still hold since the resolved invocation for these tests mirrors today's bare-name + allowlist. (Open the file and update the single construction site; the assertions on args/stdin/env are unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter "ClaudeCodeAvailabilityProbeTests|ClaudeCodeLlmProviderTests"`
Expected: FAIL — probe/provider constructors don't take a locator yet.

- [ ] **Step 3: Write minimal implementation**

Rewrite `PRism.AI.ClaudeCode/ClaudeCodeAvailabilityProbe.cs`:

```csharp
using System.ComponentModel;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Liveness probe. Resolution (find + identity) now lives in <see cref="IClaudeCliLocator"/>; this
/// probe maps a <see cref="NotFound"/> onto the reason-code vocabulary, and on a <see cref="ResolvedCli"/>
/// runs <c>claude --version</c> under the resolved invocation to confirm login/credit-independent
/// liveness. A spawn that hits an executable-not-found signature self-heals via
/// <see cref="IClaudeCliLocator.InvalidateResolved"/> so the next resolve re-discovers (spec §6/§7).
/// </summary>
public sealed class ClaudeCodeAvailabilityProbe(
    ICliProcessRunner runner,
    ClaudeCodeProviderOptions options,
    IClaudeCliLocator locator) : ILlmAvailabilityProbe
{
    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        var resolution = await locator.ResolveAsync(ct).ConfigureAwait(false);
        if (resolution is NotFound notFound)
            return LlmAvailability.Unavailable(notFound.ReasonCode);

        var resolved = (ResolvedCli)resolution;
        var spec = new ProcessSpec(
            FileName: resolved.ExecutablePath,
            Arguments: ["--version"],
            Environment: resolved.Environment,
            WorkingDirectory: options.WorkingDirectory,
            StdinText: null,
            Timeout: options.ProbeTimeout);

        ProcessResult result;
        try
        {
            result = await runner.RunAsync(spec, ct).ConfigureAwait(false);
        }
        catch (Win32Exception)
        {
            // Binary vanished between resolve and spawn → self-heal + report not-installed.
            locator.InvalidateResolved();
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        }

        var output = result.Stderr + "\n" + result.Stdout;
        if (ClaudeExecSignatures.IsExecutableNotFound(output))
        {
            // npm shim present but its `node` is gone (version-manager swap) → self-heal.
            locator.InvalidateResolved();
            return LlmAvailability.Unavailable(ClaudeReasonCodes.CliNotInstalled);
        }

        if (result.ExitCode == 0 && !result.TimedOut)
            return LlmAvailability.Ok;

        if (output.Contains("Not logged in", StringComparison.OrdinalIgnoreCase))
            return LlmAvailability.Unavailable(ClaudeReasonCodes.NotLoggedIn);
        return LlmAvailability.Unavailable(ClaudeReasonCodes.Unknown);
    }
}
```

Add the shared signature helper — create `PRism.AI.ClaudeCode/ClaudeExecSignatures.cs`:

```csharp
namespace PRism.AI.ClaudeCode;

/// <summary>Recognizes the "the binary can't launch" stderr signatures that self-heal keys on:
/// a missing executable / a missing `node` for an npm-shebang `claude` (spec §6).</summary>
internal static class ClaudeExecSignatures
{
    // Match only the CANONICAL launcher-failure forms, not a loose "contains 'node' and 'No such
    // file'" — that would fire on unrelated `claude` log lines mentioning a missing node module and
    // cause spurious re-discovery on every probe cycle. These three cover an npm-shebang `claude`
    // whose `node` is gone (`env: node: …`) and the bare-node forms.
    private static readonly string[] Signatures =
        ["env: node:", "node: No such file or directory", "node: command not found"];

    public static bool IsExecutableNotFound(string output)
    {
        if (string.IsNullOrEmpty(output)) return false;
        foreach (var sig in Signatures)
            if (output.Contains(sig, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}
```

Modify `PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs` — change the constructor and the spec build:

```csharp
public sealed class ClaudeCodeLlmProvider(
    ICliProcessRunner runner, ClaudeCodeProviderOptions options, IClaudeCliLocator locator)
    : ILlmProvider
{
    public async Task<LlmResult> CompleteAsync(LlmRequest request, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(request);

        var resolution = await locator.ResolveAsync(ct).ConfigureAwait(false);
        if (resolution is NotFound notFound)
            throw new LlmProviderException(
                $"claude CLI is not available ({notFound.ReasonCode}).",
                stderr: string.Empty, exitCode: -1);
        var resolved = (ResolvedCli)resolution;

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
            FileName: resolved.ExecutablePath,
            Arguments: args,
            Environment: resolved.Environment,
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
            locator.InvalidateResolved();   // self-heal: binary vanished post-resolve
            throw new LlmProviderException(
                "Failed to start the claude process (executable not found or not on PATH).",
                stderr: string.Empty, exitCode: -1, innerException: ex);
        }

        if (result.TimedOut)
            throw new LlmProviderException("claude -p timed out.", result.Stderr, -1, timedOut: true);
        if (result.ExitCode != 0)
        {
            if (ClaudeExecSignatures.IsExecutableNotFound(result.Stderr))
                locator.InvalidateResolved();   // npm `node` gone → re-discover next time
            throw new LlmProviderException($"claude -p failed (exit {result.ExitCode}).", result.Stderr, result.ExitCode);
        }

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
            CacheCreationInputTokens: usage?.CacheCreationInputTokens ?? 0,
            EstimatedCostUsd: envelope.TotalCostUsd);
    }
}
```

Modify `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs` — register the locator + its deps, and update the probe/provider/streaming factory registrations to resolve `IClaudeCliLocator`. Insert before the `ILlmProvider` registration:

```csharp
        services.AddSingleton<ILoginShellEnvironmentReader, SystemLoginShellEnvironmentReader>();
        // Discovery-state file lives alongside usage under the per-user dataDir's AI area.
        services.AddSingleton(_ => new JsonClaudeCliStateStore(Path.Combine(usageDir, "cli-state")));
        services.AddSingleton<IClaudeCliLocator>(sp => new ClaudeCliLocator(
            sp.GetRequiredService<ILoginShellEnvironmentReader>(),
            sp.GetRequiredService<JsonClaudeCliStateStore>(),
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            identityMatches: ClaudeIdentity.SameOsUserAsCredentialStore,
            clock: TimeProvider.System));
```

Then change the existing registrations:

```csharp
        services.AddSingleton<ILlmProvider>(sp => new ClaudeCodeLlmProvider(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>()));
```

and

```csharp
        services.AddSingleton(sp => new ClaudeCodeAvailabilityProbe(
            sp.GetRequiredService<ICliProcessRunner>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>()));
```

> `usageDir` is the per-user `llm-usage` dir (Program.cs). A `cli-state` subdir keeps the state file owner-restricted (the store chmods its own dir 700). Using `usageDir` avoids threading a new parameter through `AddPrismClaudeCode`; if a reviewer prefers a dedicated discovery dir, pass it as a new overload parameter instead.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet build --configuration Release` then `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings`
Expected: PASS (probe + provider + locator suites). Fix any other call sites the constructor change touches (see Step 5 of Task 9 for streaming + the registration tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCodeAvailabilityProbe.cs PRism.AI.ClaudeCode/ClaudeExecSignatures.cs PRism.AI.ClaudeCode/ClaudeCodeLlmProvider.cs PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs tests/PRism.AI.ClaudeCode.Tests/FakeClaudeCliLocator.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeAvailabilityProbeTests.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeLlmProviderTests.cs
git commit -m "feat(ai): wire one-shot provider + probe to ClaudeCliLocator with self-heal"
```

---

## Task 9: Streaming provider reads the resolved snapshot

**Files:**
- Modify: `PRism.AI.ClaudeCode/ClaudeCodeStreamingProvider.cs`
- Modify: `PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs`
- Test: `tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingProviderTests.cs` (adjust)

**Interfaces:**
- Consumes: `IClaudeCliLocator.CurrentResolved` (Task 5).
- Produces: `ClaudeCodeStreamingProvider(IStreamingCliProcessFactory factory, ClaudeCodeProviderOptions providerOptions, IClaudeCliLocator locator, ILoggerFactory? loggerFactory = null)`. `StartSession` builds `StreamingProcessSpec.FileName`/`Environment` from `locator.CurrentResolved` when it is a `ResolvedCli`; otherwise falls back to today's `providerOptions.ClaudeExecutable` + `ClaudeCliEnvironment.BuildAllowlisted()`.

`StartSession` is synchronous and cannot await (spec §3.2). Discovery is eager on Live-entry (Task 11) and single-flighted, so by the time a user-initiated streaming session starts, `CurrentResolved` is populated; the fallback preserves today's behavior if it is not.

- [ ] **Step 1: Write the failing test**

Add to `ClaudeCodeStreamingProviderTests.cs` (and update the existing construction helper to pass a locator):

```csharp
    [Fact]
    public void Uses_resolved_invocation_when_locator_has_one()
    {
        var env = new Dictionary<string, string> { ["PATH"] = "/opt/homebrew/bin", ["VOLTA_HOME"] = "/v" };
        var factory = new FakeStreamingCliProcessFactory();
        var provider = new ClaudeCodeStreamingProvider(
            factory,
            new ClaudeCodeProviderOptions { WorkingDirectory = TestWorkingDir },
            new FakeClaudeCliLocator(new ResolvedCli("/opt/homebrew/bin/claude", env)));

        provider.StartSession(new StreamingSessionOptions());

        factory.CapturedSpec!.FileName.Should().Be("/opt/homebrew/bin/claude");
        factory.CapturedSpec.Environment.Should().ContainKey("VOLTA_HOME");
    }

    [Fact]
    public void Falls_back_to_bare_name_when_locator_has_no_resolution()
    {
        var factory = new FakeStreamingCliProcessFactory();
        var provider = new ClaudeCodeStreamingProvider(
            factory,
            new ClaudeCodeProviderOptions { ClaudeExecutable = "claude", WorkingDirectory = TestWorkingDir },
            new FakeClaudeCliLocator(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed)));

        provider.StartSession(new StreamingSessionOptions());

        factory.CapturedSpec!.FileName.Should().Be("claude");
    }
```

> **The factory double already captures the spec as `CapturedSpec`** (`tests/PRism.AI.ClaudeCode.Tests/FakeStreamingCliProcess.cs`, `public StreamingProcessSpec? CapturedSpec`); existing streaming tests use `factory.CapturedSpec!`. Use that name — do NOT add a duplicate `Captured` property. `TestWorkingDir` already exists in the fixture.
>
> **Adding the required `IClaudeCliLocator` ctor arg breaks every existing streaming-test construction site — fix all of them in this step:**
> 1. The shared `Build(...)` helper at the top of `ClaudeCodeStreamingProviderTests.cs` (`new ClaudeCodeStreamingProvider(factory, options)`) feeds ~6 existing tests (flags, model-omitted, the env-allowlist assertion at the `BeEquivalentTo(ClaudeCliEnvironment.BuildAllowlisted().Keys)` test, etc.). Thread a `new FakeClaudeCliLocator(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed))` into it so those tests exercise the **fallback** path (bare-name + `BuildAllowlisted()`), keeping their existing assertions valid.
> 2. The 3-arg construction in the logger test (`new ClaudeCodeStreamingProvider(factory, options, loggerFactory)`) becomes 4-arg: insert the locator before `loggerFactory`.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCodeStreamingProviderTests`
Expected: FAIL — constructor has no locator param.

- [ ] **Step 3: Write minimal implementation**

In `ClaudeCodeStreamingProvider.cs`, change the primary constructor and the spec build:

```csharp
public sealed class ClaudeCodeStreamingProvider(
    IStreamingCliProcessFactory factory,
    ClaudeCodeProviderOptions providerOptions,
    IClaudeCliLocator locator,
    ILoggerFactory? loggerFactory = null) : IStreamingLlmProvider
```

and replace the `StreamingProcessSpec` construction:

```csharp
        // StartSession is synchronous (cannot await). Read the locator's memoized snapshot; eager
        // Live-entry discovery (single-flighted) means it is populated by the time a user starts a
        // session. Fall back to today's bare-name invocation if not yet resolved (spec §3.2).
        var (fileName, environment) = locator.CurrentResolved is ResolvedCli resolved
            ? (resolved.ExecutablePath, resolved.Environment)
            : (providerOptions.ClaudeExecutable, (IReadOnlyDictionary<string, string>)ClaudeCliEnvironment.BuildAllowlisted());

        var spec = new StreamingProcessSpec(
            FileName: fileName,
            Arguments: args,
            Environment: environment,
            WorkingDirectory: workingDir);
```

Update the DI registration in `ServiceCollectionExtensions.cs` to inject the locator:

```csharp
        services.AddSingleton<IStreamingLlmProvider>(sp => new ClaudeCodeStreamingProvider(
            sp.GetRequiredService<IStreamingCliProcessFactory>(),
            sp.GetRequiredService<ClaudeCodeProviderOptions>(),
            sp.GetRequiredService<IClaudeCliLocator>(),
            sp.GetRequiredService<ILoggerFactory>()));
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings --filter ClaudeCodeStreamingProviderTests`
Expected: PASS. Then run the full project: `dotnet test tests/PRism.AI.ClaudeCode.Tests --configuration Release --settings .runsettings` and fix any registration-test fallout (`ServiceRegistrationTests`, `StreamingServiceRegistrationTests` resolve these singletons — they should still resolve cleanly now that the locator is registered).

- [ ] **Step 5: Commit**

```bash
git add PRism.AI.ClaudeCode/ClaudeCodeStreamingProvider.cs PRism.AI.ClaudeCode/ServiceCollectionExtensions.cs tests/PRism.AI.ClaudeCode.Tests/ClaudeCodeStreamingProviderTests.cs
git commit -m "feat(ai): streaming provider builds spec from locator snapshot with fallback"
```

---

## Task 10: Non-compounding-TTL contract in the cached probe

**Files:**
- Modify: `PRism.Web/Ai/CachedLlmAvailabilityProbe.cs`
- Test: `tests/PRism.Web.Tests/Ai/CachedLlmAvailabilityProbeTests.cs` (add cases)

**Interfaces:**
- Consumes: `LlmAvailability.ReasonCode`, `ClaudeReasonCodes.CliNotInstalled` / `CliDiscoveryFailed`.
- Produces: `CachedLlmAvailabilityProbe` no longer memoizes a result whose reason code is a **discovery-owned negative** (`cli-not-installed` or `cli-discovery-failed`); those pass straight through to the inner probe (and thus the locator's own negative TTL) on every call. This honors spec §7: the locator owns the sole negative TTL for discovery; the liveness cache must not extend a discovery-negative for a fresh 30s on top, which would double recovery latency to ~60s.

This does **not** raise the `claude --version` spawn rate: a discovery-negative result is produced *without* running `--version` (the probe returns before spawning on a `NotFound`), and the locator memoizes the discovery negative for its own TTL, so repeated passthrough calls hit the locator's in-memory negative, not a new login-shell spawn.

- [ ] **Step 1: Write the failing test**

Add to `tests/PRism.Web.Tests/Ai/CachedLlmAvailabilityProbeTests.cs`:

```csharp
    [Fact]
    public async Task Does_not_cache_cli_not_installed_so_recovery_is_not_doubled()
    {
        var inner = new SequenceProbe(new[]
        {
            LlmAvailability.Unavailable("cli-not-installed"),   // 1st call
            LlmAvailability.Ok,                                 // 2nd call (installed mid-session)
        });
        var cached = new CachedLlmAvailabilityProbe(inner, new ManualTimeProvider(), TimeSpan.FromSeconds(30));

        (await cached.ProbeAsync(default)).ReasonCode.Should().Be("cli-not-installed");
        // No clock advance: a normal result would be served from cache; a discovery-negative must NOT be.
        (await cached.ProbeAsync(default)).Should().Be(LlmAvailability.Ok);
        inner.CallCount.Should().Be(2);
    }

    [Fact]
    public async Task Does_not_cache_cli_discovery_failed()
    {
        var inner = new SequenceProbe(new[]
        {
            LlmAvailability.Unavailable("cli-discovery-failed"),
            LlmAvailability.Ok,
        });
        var cached = new CachedLlmAvailabilityProbe(inner, new ManualTimeProvider(), TimeSpan.FromSeconds(30));

        await cached.ProbeAsync(default);
        (await cached.ProbeAsync(default)).Should().Be(LlmAvailability.Ok);
        inner.CallCount.Should().Be(2);
    }

    [Fact]
    public async Task Still_caches_ok_and_not_logged_in()
    {
        var inner = new SequenceProbe(new[]
        {
            LlmAvailability.Unavailable("not-logged-in"),
            LlmAvailability.Ok,   // must NOT be reached within TTL
        });
        var cached = new CachedLlmAvailabilityProbe(inner, new ManualTimeProvider(), TimeSpan.FromSeconds(30));

        await cached.ProbeAsync(default);
        (await cached.ProbeAsync(default)).ReasonCode.Should().Be("not-logged-in");   // served from cache
        inner.CallCount.Should().Be(1);
    }
```

Add a tiny `SequenceProbe` test double (in the test file or a shared test helper) that returns successive results and counts calls:

```csharp
    private sealed class SequenceProbe : ILlmAvailabilityProbe
    {
        private readonly LlmAvailability[] _results;
        public int CallCount { get; private set; }
        public SequenceProbe(LlmAvailability[] results) => _results = results;
        public Task<LlmAvailability> ProbeAsync(CancellationToken ct)
        {
            var r = _results[Math.Min(CallCount, _results.Length - 1)];
            CallCount++;
            return Task.FromResult(r);
        }
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --configuration Release --settings .runsettings --filter CachedLlmAvailabilityProbeTests`
Expected: FAIL — the cache currently memoizes all results, so call 2 is served from cache (`CallCount == 1`).

- [ ] **Step 3: Write minimal implementation**

In `CachedLlmAvailabilityProbe.cs`, add a passthrough guard. Add the discovery-negative reason codes as a static set and skip caching for them. Replace the body of `ProbeAsync`'s write path:

```csharp
    // Discovery-owned negatives: the ClaudeCliLocator owns their (sole) negative TTL. Re-caching them
    // here for a fresh TTL would compound into ~2× recovery latency after a mid-session install (spec §7).
    // PRism.Web already references PRism.AI.ClaudeCode (it calls AddPrismClaudeCode), so use the shared
    // constants rather than literals — a reason-code rename then stays a single edit.
    private static readonly HashSet<string> DiscoveryNegativeReasonCodes =
        new(StringComparer.Ordinal) { ClaudeReasonCodes.CliNotInstalled, ClaudeReasonCodes.CliDiscoveryFailed };

    public async Task<LlmAvailability> ProbeAsync(CancellationToken ct)
    {
        var now = _clock.GetUtcNow();
        var entry = _entry;
        if (entry is not null && now - entry.At < _ttl) return entry.Value;

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            now = _clock.GetUtcNow();
            entry = _entry;
            if (entry is not null && now - entry.At < _ttl) return entry.Value;

            var result = await _inner.ProbeAsync(ct).ConfigureAwait(false);
            // Pass discovery-negatives straight through — do not extend them past the locator's TTL.
            if (!DiscoveryNegativeReasonCodes.Contains(result.ReasonCode))
                _entry = new CacheEntry(result, _clock.GetUtcNow());
            return result;
        }
        finally
        {
            _gate.Release();
        }
    }
```

> Add `using PRism.AI.ClaudeCode;` to `CachedLlmAvailabilityProbe.cs` for the `ClaudeReasonCodes` constants (the assembly is already referenced by `PRism.Web`). `ManualTimeProvider` is the existing hand-rolled `TimeProvider` stub already defined in `CachedLlmAvailabilityProbeTests.cs` — reuse it; `PRism.Web.Tests` does **not** reference `Microsoft.Extensions.TimeProvider.Testing`, so do not introduce `FakeTimeProvider` here. The new tests don't advance the clock (they assert "would be cached within TTL" via no advance), so a fixed-time `ManualTimeProvider` suffices.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --configuration Release --settings .runsettings --filter CachedLlmAvailabilityProbeTests`
Expected: PASS (new + existing cache tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/CachedLlmAvailabilityProbe.cs tests/PRism.Web.Tests/Ai/CachedLlmAvailabilityProbeTests.cs
git commit -m "feat(ai): cached probe passes discovery-negatives through (no compounded TTL)"
```

---

## Task 11: Eager-on-Live-entry warmup + final composition

**Files:**
- Create: `PRism.Web/Ai/ClaudeCliDiscoveryWarmup.cs`
- Modify: `PRism.Web/Program.cs`
- Test: `tests/PRism.Web.Tests/Ai/ClaudeCliDiscoveryWarmupTests.cs`

**Interfaces:**
- Consumes: `IClaudeCliLocator.ResolveAsync` (Task 5), `IConfigStore` (`Current.Ui.Ai.Mode`, `Changed`), `AiMode.Live`.
- Produces: `internal sealed class ClaudeCliDiscoveryWarmup : IHostedService` that, on `StartAsync`, fires `_ = locator.ResolveAsync(...)` when the current mode is `Live`, and subscribes to `IConfigStore.Changed` to fire the same when the mode transitions into `Live`. Fire-and-forget (discovery is single-flighted + off the request path, spec §7). `StopAsync` unsubscribes.

This moves the ~`DiscoveryTimeout + ProbeTimeout` (~20s) worst case off the first user-facing `/api/capabilities` probe: the probe either finds resolution already complete, or sees it in-flight (single-flight) and the FE renders its existing "probing/unavailable" affordance until it lands.

- [ ] **Step 1: Write the failing test**

Create `tests/PRism.Web.Tests/Ai/ClaudeCliDiscoveryWarmupTests.cs`:

```csharp
using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.AI.ClaudeCode;
using PRism.Core.Ai;
using PRism.Web.Ai;

namespace PRism.Web.Tests.Ai;

public sealed class ClaudeCliDiscoveryWarmupTests
{
    private sealed class CountingLocator : IClaudeCliLocator
    {
        public int ResolveCount { get; private set; }
        public Task<ClaudeCliResolution> ResolveAsync(CancellationToken ct)
        {
            ResolveCount++;
            return Task.FromResult<ClaudeCliResolution>(new NotFound(ClaudeReasonCodes.CliDiscoveryFailed));
        }
        public ClaudeCliResolution? CurrentResolved => null;
        public void InvalidateResolved() { }
    }

    [Fact]
    public async Task Warms_discovery_on_start_when_mode_is_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Live);   // test double exposing Current + Changed
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);

        await warmup.StartAsync(CancellationToken.None);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        locator.ResolveCount.Should().BeGreaterThanOrEqualTo(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Does_not_warm_on_start_when_mode_is_not_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Preview);
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);

        await warmup.StartAsync(CancellationToken.None);
        await Task.Delay(50);

        locator.ResolveCount.Should().Be(0);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Warms_discovery_when_mode_transitions_to_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Preview);
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);
        await warmup.StartAsync(CancellationToken.None);

        config.RaiseModeChanged(AiMode.Live);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        locator.ResolveCount.Should().BeGreaterThanOrEqualTo(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    [Fact]
    public async Task Does_not_rewarm_on_a_config_change_that_does_not_enter_live()
    {
        var locator = new CountingLocator();
        var config = new FakeConfigStore(AiMode.Live);   // already Live at startup → warms once
        var warmup = new ClaudeCliDiscoveryWarmup(locator, config, NullLogger<ClaudeCliDiscoveryWarmup>.Instance);
        await warmup.StartAsync(CancellationToken.None);
        await WaitForAsync(() => locator.ResolveCount >= 1);

        // A later config save while STILL Live (consent recorded, timeout tweaked, file-watcher reload)
        // must NOT re-fire discovery: RaiseChanged fires unconditionally, but there's no not-Live→Live edge.
        config.RaiseModeChanged(AiMode.Live);
        await Task.Delay(50);

        locator.ResolveCount.Should().Be(1);
        await warmup.StopAsync(CancellationToken.None);
    }

    private static async Task WaitForAsync(Func<bool> condition)
    {
        for (var i = 0; i < 100 && !condition(); i++) await Task.Delay(10);
    }
}
```

> `FakeConfigStore` is a test double exposing `IConfigStore.Current` (an `AppConfig` with `Ui.Ai.Mode` set) and a `Changed` event plus a `RaiseModeChanged(AiMode)` helper that fires `Changed` **unconditionally** (modeling `ConfigStore.RaiseChanged`, which fires on every mutation even when the mode is unchanged — this is what the transition-dedup test exercises) with a `ConfigChangedEventArgs` carrying the new mode. Check whether the Web test project already has a config-store fake (several Web tests mutate `AiModeState`/config); reuse it and add a `RaiseModeChanged` helper if missing rather than writing a new one. Match the real `ConfigChangedEventArgs` shape (`e.Config.Ui.Ai.Mode`).
>
> The warmup test consumes `PRism.AI.ClaudeCode` types (`IClaudeCliLocator`, `NotFound`, `ClaudeReasonCodes`) directly. `PRism.Web.Tests.csproj` references those only transitively through `PRism.Web`. SDK-style projects flow transitive project references at compile time by default, so this should compile — but confirm the symbols are visible, and if not (e.g. `PRism.Web` ever sets `PrivateAssets`/`ReferenceOutputAssembly=false` on the reference), add an explicit `<ProjectReference Include="..\..\PRism.AI.ClaudeCode\PRism.AI.ClaudeCode.csproj" />` to the test csproj.

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests --configuration Release --settings .runsettings --filter ClaudeCliDiscoveryWarmupTests`
Expected: FAIL — `ClaudeCliDiscoveryWarmup` does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `PRism.Web/Ai/ClaudeCliDiscoveryWarmup.cs`:

```csharp
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using PRism.AI.ClaudeCode;
using PRism.Core.Ai;
using PRism.Core.Config;

namespace PRism.Web.Ai;

/// <summary>
/// Eager-on-Live-entry discovery trigger (spec §7). Kicks off CLI resolution as a background task when
/// AI mode TRANSITIONS into Live (or starts Live), so the first user-facing <c>/api/capabilities</c>
/// probe never pays the ~20s worst-case discovery latency on the request path. Resolution is
/// single-flighted in the locator, so firing here and a concurrent probe never spawn two login shells.
/// </summary>
internal sealed class ClaudeCliDiscoveryWarmup : IHostedService
{
    private readonly IClaudeCliLocator _locator;
    private readonly IConfigStore _config;
    private readonly ILogger<ClaudeCliDiscoveryWarmup> _logger;

    // ConfigStore.RaiseChanged fires on EVERY mutation (consent, timeout, theme, a file-watcher
    // reload), not just a mode change — and the event carries no previous value. Track the last-seen
    // mode so we only warm on a not-Live -> Live TRANSITION, not on every save while already Live.
    // A benign race here (duplicate Warm) is absorbed by the locator's single-flight + memoization.
    private AiMode _lastMode;

    public ClaudeCliDiscoveryWarmup(
        IClaudeCliLocator locator, IConfigStore config, ILogger<ClaudeCliDiscoveryWarmup> logger)
    {
        _locator = locator;
        _config = config;
        _logger = logger;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _config.Changed += OnConfigChanged;
        _lastMode = _config.Current.Ui.Ai.Mode;
        if (_lastMode == AiMode.Live) Warm();   // start-as-Live warms once
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _config.Changed -= OnConfigChanged;
        return Task.CompletedTask;
    }

    private void OnConfigChanged(object? sender, ConfigChangedEventArgs e)
    {
        var mode = e.Config.Ui.Ai.Mode;
        if (mode == AiMode.Live && _lastMode != AiMode.Live) Warm();   // transition only
        _lastMode = mode;
    }

    // Fire-and-forget: discovery is off the request path and single-flighted. Log (don't rethrow) so a
    // discovery error never tears down the host but a state-dir permission/IO regression still leaves a
    // signal; the next probe re-attempts via the negative TTL.
    private void Warm() => _ = SafeResolveAsync();

    private async Task SafeResolveAsync()
    {
        try { await _locator.ResolveAsync(CancellationToken.None).ConfigureAwait(false); }
        catch (Exception ex) { _logger.LogWarning(ex, "CLI discovery warmup faulted; will retry via negative TTL."); }
    }
}
```

Register it in `PRism.Web/Program.cs` after `AddPrismClaudeCode(...)` / `AddPrismAi()`:

```csharp
builder.Services.AddHostedService<ClaudeCliDiscoveryWarmup>();
```

(Add `using PRism.Web.Ai;` if not already present.)

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests --configuration Release --settings .runsettings --filter ClaudeCliDiscoveryWarmupTests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Ai/ClaudeCliDiscoveryWarmup.cs PRism.Web/Program.cs tests/PRism.Web.Tests/Ai/ClaudeCliDiscoveryWarmupTests.cs
git commit -m "feat(ai): eager-on-Live-entry CLI discovery warmup hosted service"
```

---

## Task 12: Full-suite green + docs

**Files:**
- Modify: `.ai/docs/architectural-invariants.md` or the AI substrate doc (whichever documents the env allowlist / CLI invocation), per `.ai/docs/documentation-maintenance.md`.
- Test: the whole backend suite.

**Interfaces:** none — this is the verify-and-document gate.

- [ ] **Step 1: Run the full backend build + test**

Run (from the worktree root): `dotnet build --configuration Release` then `dotnet test --no-build --configuration Release --settings .runsettings`
Expected: PASS. Investigate and fix any registration tests that assert the AI seam set (`ServiceRegistrationTests`, `StreamingServiceRegistrationTests`, `AvailabilityProbeRegistrationTests`, the composition seam-registration tests) — they should resolve the new `IClaudeCliLocator` singleton cleanly. Do not weaken an assertion to make it pass; if one fails, the registration wiring is the bug.

- [ ] **Step 2: Update the AI substrate doc**

Find the doc that records the CLI env allowlist + invocation invariants (grep `.ai/docs` for `Allowlist` / `ClaudeExecutable` / `BuildAllowlisted`). Add a short subsection: discovery is sidecar-owned and Unix-only; the persisted state record holds `path` + `managerVars` only; the manager-var allowlist is path-pointing and gated for expansion; Windows is an exact no-op. Keep it to the invariants, not the mechanism (the spec is the mechanism of record).

- [ ] **Step 3: Commit**

```bash
git add .ai/docs
git commit -m "docs(ai): record sidecar-owned Unix CLI discovery + manager-var allowlist invariant"
```

- [ ] **Step 4: Run the pre-push checklist**

Run the backend portion of the pre-push checklist verbatim (`.ai/docs/development-process.md` steps; frontend steps 1–3 and 6 are no-ops — this change has zero frontend surface). Confirm green before any push.

- [ ] **Step 5: Record the manual-P1 validation list (not CI)**

These cannot be unit-tested and MUST be validated on a real Mac before the macOS `.app` cohort hand-out. Add them to the spec's manual-P1 list (or the PR `## Proof` section); they are the residual risk this plan cannot close in code:

- **Real-Mac login-shell capture, both topologies.** `SystemLoginShellEnvironmentReader` against zsh + bash, with a native install (`~/.local/bin`) AND an npm/nvm/volta install, launched from a **packaged `.app` from Finder** (minimal launchd PATH). Confirm `command -v claude` + `/usr/bin/env` capture cleanly under the cleared spawn env.
- **`HOME` presence in a Finder-launched `.app`** (adversarial F3). Confirm the sidecar's `HOME` is set; if it can be unset, verify the ladder's `~/.local/bin` probe still fires (the `Environment.GetFolderPath(UserProfile)` fallback added in Task 6) and that `claude` credential lookup still resolves the right profile.
- **Prompt-framework / rc-noise robustness** (adversarial F5). Run capture against a real powerlevel10k-instant-prompt + `clear`-in-rc setup and confirm the env block parses clean (the `IsValidEnvKey` guard added in Task 4 holds against interleaved escape sequences).
- **npm-node-exec empirical check** (spec §9). Confirm `claude --version` on an npm/nvm install actually execs `node` (so exit 0 genuinely proves node-reachability), and that `fnm`/`asdf` export their manager vars in a non-interactive-hook login shell.
- **Notarized/hardened-runtime `.app`** (spec §8). Confirm Gatekeeper/TCC does not block the sidecar's child-shell spawn; if it does, the §4.5 native-path ladder (no shell spawn) must still resolve.
- **arm64 concurrency note** (adversarial F1/F6): the `_negative` torn-read fix (immutable `NegativeEntry`) is correct-by-construction and matches `CacheEntry`; it is **not** reproducible on x64 CI, so there is no CI test for it — the fix is the guarantee, reviewed against the established pattern.

---

## Self-Review

**Spec coverage** (each spec section → task):

- §1 / §1.1 (problem, two topologies) → addressed by the whole design; topology-specific behavior tested in Task 6 (`Cold_discovery_native_topology…`, `Cold_discovery_npm_topology…`).
- §2 goals/non-goals → Windows no-op (Task 5), discover-once-persist (Tasks 3, 6, 7), self-heal (Tasks 5, 7, 8), security invariants (Task 2), zero Windows behavior change (Task 5 + Task 12 registration tests).
- §3 architecture / components → `ClaudeCliResolution` (T1), `ClaudeCliEnvironment` (T2), `JsonClaudeCliStateStore` (T3), `ILoginShellEnvironmentReader` (T4), `IClaudeCliLocator` (T5–T7). §3.2 integration seam → one-shot/probe (T8), streaming (T9), `NotFound` reason-code mapping incl. `CliDiscoveryFailed` (T1, T8).
- §4 discovery mechanism → cleared-env login-shell spawn + sentinels (T4), candidate pick + exec-validate + ladder (T6), `DiscoveryTimeout` (T5).
- §5 env filtering → `FilterCaptured` case-sensitive POSIX + manager-var allowlist + exclusions + TMPDIR (T2).
- §6 persistence & self-heal → positive-only store + rebuild-on-load (T3), warm reuse + vanished-path + exec-not-found self-heal + negative TTL (T5, T7, T8).
- §7 lifecycle/concurrency/latency/Windows → eager warmup (T11), single-flight (T5), non-compounding TTL (T10), Windows no-op (T5).
- §8 risks → timeout (T4), ladder for non-POSIX (T6); PATH-shadowing/notarization are accepted/P1, no code task.
- §9 testing strategy → covered across T2–T11; manual P1 items (real-Mac shell capture, notarization, npm-node-exec empirical) are explicitly **not** CI tasks and remain in the spec's manual-P1 list.
- §10 out-of-scope → no tasks (correct).

**Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N" — every code step shows full code. The two spots that defer to judgment (the `cli-state` dir-naming reviewer note in T8; the `FakeConfigStore` reuse note in T11) are flagged as reviewer choices with a concrete default, not unfinished work.

**Type consistency:** `ClaudeCliResolution`/`ResolvedCli`/`NotFound`, `ResolveAsync`/`CurrentResolved`/`InvalidateResolved`, `FilterCaptured`, `RebuildEnv`, `ClaudeCliStateRecord` fields, `LoginShellCapture(Environment, CommandVClaude)`, `ParseCapture(stdout, s1, s2, s3)`, `ClaudeExecSignatures.IsExecutableNotFound`, `DiscoveryTimeout`/`NegativeTtl` — names are used identically across the tasks that produce and consume them. The probe/provider/streaming constructors all take `IClaudeCliLocator` in the same position relative to `ClaudeCodeProviderOptions`.

No cross-task ordering wrinkles remain: the `Single_flight` test now lives in Task 6 (where the cold path it exercises is implemented), removing the skip-then-unskip trap an earlier draft carried.

---

## Review Dispositions — 2026-06-22 `ce-doc-review` (plan)

Five personas (coherence, feasibility, security-lens, scope-guardian, adversarial). Every finding and its action.

**Applied**
- *Adversarial F1 — torn lock-free read of `_negative` on arm64:* wrapped value+timestamp in an immutable `NegativeEntry` record (single reference load), matching the `CacheEntry` pattern it cited (Task 5).
- *Adversarial F2 — self-heal thundering-herd (warm-reuse → spawn-fail → invalidate loop on a present-but-broken shim):* `InvalidateResolved` now discards the **persisted record** (spec §6 "discard the record"), not just in-memory state, and no longer nukes the negative backoff; added a regression test (Tasks 5, 7).
- *Adversarial F3 — `HOME`-less ladder in a Finder `.app`:* ladder falls back to `Environment.GetFolderPath(UserProfile)` for the `~/.local/bin` probe (without synthesizing `HOME` into the child env); added a P1 validation item (Task 6, 12).
- *Adversarial F4 — warmup re-fires on every config save (no transition de-dup):* track `_lastMode`, warm only on not-Live→Live; added a regression test (Task 11).
- *Adversarial F5 — interleaved rc stdout (p10k/`clear`) corrupting the env-block parse:* `ParseCapture` now requires a valid POSIX env-var name before `=`; added a test + a P1 check (Task 4, 12).
- *Adversarial F6 — false-green for F1/F2:* added the F2 record-discard regression test; documented that F1's arm64 path can't be CI-reproduced (the fix is the guarantee) (Tasks 7, 12).
- *Security — temp-file TOCTOU (world-readable between write and chmod):* create the temp file with `UnixCreateMode 600` at open time via `FileStreamOptions`, no post-write chmod window (Task 3).
- *Feasibility — `FakeTimeProvider` unavailable in `PRism.Web.Tests`:* Task 10 uses the existing hand-rolled `ManualTimeProvider`.
- *Feasibility — streaming double is `CapturedSpec`, not `Captured`:* fixed; expanded Task 9 to update the shared `Build` helper + the 4-arg logger-test site.
- *Feasibility — `dotnet add package` breaks under central package management (NU1008):* Task 7 now adds a version-less `PackageReference` (CPM pins the version).
- *Feasibility — `PRism.Web.Tests` reaches `PRism.AI.ClaudeCode` only transitively:* added a confirm-and-add-explicit-reference note (Task 11).
- *Scope-guardian + Security — `ClaudeExecSignatures` too broad (`node` + `No such file` two-`Contains`):* tightened to three canonical launcher-failure signatures (Task 8).
- *Scope-guardian — `Single_flight` cross-task skip trap:* moved the test entirely into Task 6 (Task 5/6).
- *Scope-guardian — literal reason codes despite `PRism.Web` referencing the assembly:* use `ClaudeReasonCodes` constants (Task 10).
- *Scope-guardian — ladder env-subset not asserted:* added an env-subset assertion to a ladder test (Task 6).
- *Coherence — `ClaudeExecSignatures.cs` missing from File Structure:* added.
- *Scope-guardian — `pathExists` is a test seam:* added a clarifying comment (Task 5).

**Skipped (with reason)**
- *Scope-guardian / Security — defense-in-depth explicit denylist assertion in `FilterCaptured`:* the allowlist-only construction makes a denylist redundant, and the Task-2 test already asserts banned vars are absent; adding a denylist would contradict the spec's allowlist-only philosophy. (Both reviewers ultimately rated this "sound, no gap.")
- *Scope-guardian advisory — `Task.Delay(50)` negative timing assertion in the warmup test:* a negative assertion ("nothing happened") cannot be expressed as a poll; a short fixed delay is the standard tool for hosted-service no-op tests. Acknowledged, no change.

**Noted, no doc change**
- Coherence, security, and feasibility each independently confirmed large areas sound (login-shell `-ilc` PATH ordering, no stderr-drain deadlock, sync `StartSession`, chmod layering, `RebuildEnv` re-filtering, sentinel non-injectability, `CliVersion` non-sensitivity, `FilterCaptured` case-handling). No action required.

---

## Execution Handoff

Plan complete and saved to `docs/plans/2026-06-22-claude-cli-discovery-macos.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
