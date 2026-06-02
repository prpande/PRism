# Electron Desktop Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wrap the existing PRism localhost web app in an Electron desktop shell (own window, single-instance, app icon, clean quit) shipped as unsigned cross-platform installers, without forking the app's runtime.

**Architecture:** Electron main process (Node/TypeScript, new `desktop/` directory) spawns the existing self-contained `PRism.Web` binary as a managed sidecar, learns its bound port from stdout, health-gates on `GET /api/health`, and points a sandboxed `BrowserWindow` at `http://127.0.0.1:<port>`. The .NET app is unchanged except for four small, sidecar-gated seams that land on `main` first. Single-instance is Electron's `requestSingleInstanceLock()`; the backend lockfile stays as the dataDir-integrity guard.

**Tech Stack:** .NET 10 / ASP.NET Core (sidecar), Electron + electron-builder + TypeScript (shell), Playwright `_electron` (shell e2e), GitHub Actions matrix (`windows-latest` + `macos-latest`).

**Source spec:** [`../specs/2026-06-02-electron-desktop-shell-design.md`](../specs/2026-06-02-electron-desktop-shell-design.md). Deferrals: [`../specs/2026-06-02-electron-desktop-shell-deferrals.md`](../specs/2026-06-02-electron-desktop-shell-deferrals.md).

---

## Branch & PR strategy

- **Phase A (backend seams)** lands on **`main`** as small standalone PRs — each is harmless to browser-tab mode and independently valid. This keeps the `desktop` branch purely additive.
- **Phases B–D (`desktop/` shell, packaging, e2e, docs)** land on the long-lived **`desktop`** branch (developed in a git worktree), merging `main` → `desktop` frequently, and merge back to `main` as **v0.2.0**.

Sidecar mode is signalled by the environment variable **`PRISM_SIDECAR=1`** (never a CLI flag — not inspectable via `ps`/`wmic`, not trivially spoofable). The parent (Electron) PID is passed as **`PRISM_PARENT_PID`**.

---

## File structure

**Phase A — backend (`main`):**
- Modify: `PRism.Web/Program.cs` — sidecar-mode detection; bind `127.0.0.1` + report it in sidecar mode; register the watchdog hosted service; register Host-header middleware.
- Create: `PRism.Core/Hosting/SidecarMode.cs` — reads `PRISM_SIDECAR` / `PRISM_PARENT_PID`.
- Create: `PRism.Core/Hosting/ParentLivenessProbe.cs` — recycle-resistant parent-alive check (pure, unit-tested).
- Create: `PRism.Web/Hosting/ParentLivenessWatchdog.cs` — `IHostedService` polling the probe, stops the app when the parent dies.
- Create: `PRism.Web/Middleware/HostHeaderCheckMiddleware.cs` — DNS-rebinding defense (loopback Host allowlist).
- Test: `tests/PRism.Core.Tests/Hosting/ParentLivenessProbeTests.cs`, `tests/PRism.Core.Tests/Hosting/SidecarModeTests.cs`, `tests/PRism.Web.Tests/Middleware/HostHeaderCheckMiddlewareTests.cs`, `tests/PRism.Web.Tests/Hosting/SidecarLaunchContractTests.cs`.

**Phases B–D — shell (`desktop`):**
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/.gitignore`.
- Create: `desktop/src/main.ts` — app entry (single-instance, spawn, window, quit).
- Create: `desktop/src/sidecar.ts` — spawn + stdout-port-parse + health-poll + teardown.
- Create: `desktop/src/ports.ts` — pure helpers (`parsePortFromLine`, `pollHealth`) for unit tests.
- Create: `desktop/electron-builder.yml`.
- Create: `desktop/assets/icons/` — `icon.ico`, `icon.icns`, `icon.png` (from existing source).
- Create: `desktop/test/shell.e2e.ts`, `desktop/playwright.config.ts`.
- Create: `desktop/test/ports.unit.test.ts`.
- Create: `.github/workflows/publish-desktop.yml`.
- Create: `TESTING.md` (repo root).
- Modify: `docs/specs/README.md`, `docs/roadmap.md`.

---

## PHASE A — Backend seams (land on `main`)

### Task A1: Sidecar-mode detection helper

**Files:**
- Create: `PRism.Core/Hosting/SidecarMode.cs`
- Test: `tests/PRism.Core.Tests/Hosting/SidecarModeTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core.Hosting;

namespace PRism.Core.Tests.Hosting;

public class SidecarModeTests
{
    [Fact]
    public void Detect_WhenFlagIsOne_ReturnsEnabledWithParentPid()
    {
        var env = new Dictionary<string, string?>
        {
            ["PRISM_SIDECAR"] = "1",
            ["PRISM_PARENT_PID"] = "4242",
        };

        var mode = SidecarMode.Detect(key => env.GetValueOrDefault(key));

        Assert.True(mode.Enabled);
        Assert.Equal(4242, mode.ParentPid);
    }

    [Fact]
    public void Detect_WhenFlagAbsent_ReturnsDisabled()
    {
        var mode = SidecarMode.Detect(_ => null);

        Assert.False(mode.Enabled);
        Assert.Null(mode.ParentPid);
    }

    [Fact]
    public void Detect_WhenFlagSetButParentPidUnparseable_EnabledWithNullPid()
    {
        var env = new Dictionary<string, string?>
        {
            ["PRISM_SIDECAR"] = "1",
            ["PRISM_PARENT_PID"] = "not-a-number",
        };

        var mode = SidecarMode.Detect(key => env.GetValueOrDefault(key));

        Assert.True(mode.Enabled);
        Assert.Null(mode.ParentPid);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SidecarModeTests"`
Expected: FAIL — `SidecarMode` does not exist (compile error).

- [ ] **Step 3: Write minimal implementation**

```csharp
namespace PRism.Core.Hosting;

/// <summary>
/// Reads the sidecar-activation signal the Electron shell passes via environment
/// variables (never CLI flags — keeps them out of the process list and harder to spoof).
/// </summary>
public sealed record SidecarMode(bool Enabled, int? ParentPid)
{
    public static SidecarMode Detect(Func<string, string?> getEnv)
    {
        ArgumentNullException.ThrowIfNull(getEnv);

        var enabled = string.Equals(getEnv("PRISM_SIDECAR"), "1", StringComparison.Ordinal);
        if (!enabled)
            return new SidecarMode(false, null);

        return int.TryParse(getEnv("PRISM_PARENT_PID"), out var pid)
            ? new SidecarMode(true, pid)
            : new SidecarMode(true, null);
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~SidecarModeTests"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/SidecarMode.cs tests/PRism.Core.Tests/Hosting/SidecarModeTests.cs
git commit -m "feat(hosting): add SidecarMode env-var detection for Electron shell"
```

---

### Task A2: Recycle-resistant parent-liveness probe

**Files:**
- Create: `PRism.Core/Hosting/ParentLivenessProbe.cs`
- Test: `tests/PRism.Core.Tests/Hosting/ParentLivenessProbeTests.cs`

The probe captures the parent's start-time at construction (when the parent is known alive) and reports "dead" if the PID disappears OR the start-time changes (PID was recycled to a new process). This is the recycle-resistance refinement over a bare PID check.

- [ ] **Step 1: Write the failing test**

```csharp
using PRism.Core.Hosting;

namespace PRism.Core.Tests.Hosting;

public class ParentLivenessProbeTests
{
    // Fake process accessor: returns a start-time for a pid, or null if "not running".
    private static Func<int, DateTime?> Accessor(Dictionary<int, DateTime?> table)
        => pid => table.TryGetValue(pid, out var t) ? t : null;

    [Fact]
    public void IsParentAlive_WhenPidPresentAndStartTimeStable_ReturnsTrue()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table));

        Assert.NotNull(probe);
        Assert.True(probe!.IsParentAlive());
    }

    [Fact]
    public void IsParentAlive_WhenPidDisappears_ReturnsFalse()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table))!;

        table[100] = null; // parent exited

        Assert.False(probe.IsParentAlive());
    }

    [Fact]
    public void IsParentAlive_WhenPidRecycledToNewProcess_ReturnsFalse()
    {
        var start = new DateTime(2026, 6, 2, 10, 0, 0, DateTimeKind.Utc);
        var table = new Dictionary<int, DateTime?> { [100] = start };
        var probe = ParentLivenessProbe.Arm(100, Accessor(table))!;

        table[100] = start.AddMinutes(5); // same PID, different process (recycled)

        Assert.False(probe.IsParentAlive());
    }

    [Fact]
    public void Arm_WhenParentAlreadyGone_ReturnsNull()
    {
        var probe = ParentLivenessProbe.Arm(100, Accessor(new Dictionary<int, DateTime?>()));
        Assert.Null(probe);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ParentLivenessProbeTests"`
Expected: FAIL — `ParentLivenessProbe` does not exist.

- [ ] **Step 3: Write minimal implementation**

```csharp
using System.Diagnostics;

namespace PRism.Core.Hosting;

/// <summary>
/// Recycle-resistant check that a parent process (the Electron shell) is still the
/// same live process. Captures the parent's start-time at arm-time; a later PID hit
/// with a different start-time means the PID was recycled — treated as "parent dead".
/// </summary>
public sealed class ParentLivenessProbe
{
    private readonly int _parentPid;
    private readonly DateTime _armedStart;
    private readonly Func<int, DateTime?> _startTimeOf;

    private ParentLivenessProbe(int parentPid, DateTime armedStart, Func<int, DateTime?> startTimeOf)
    {
        _parentPid = parentPid;
        _armedStart = armedStart;
        _startTimeOf = startTimeOf;
    }

    /// <summary>Arm against a parent PID. Returns null if the parent is already gone.</summary>
    public static ParentLivenessProbe? Arm(int parentPid, Func<int, DateTime?> startTimeOf)
    {
        ArgumentNullException.ThrowIfNull(startTimeOf);
        var start = startTimeOf(parentPid);
        return start is null ? null : new ParentLivenessProbe(parentPid, start.Value, startTimeOf);
    }

    /// <summary>Real-process accessor for production use.</summary>
    public static DateTime? StartTimeOfProcess(int pid)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            return p.StartTime.ToUniversalTime();
        }
        catch (ArgumentException) { return null; }       // no such process
        catch (InvalidOperationException) { return null; } // exited between lookup and read
    }

    public bool IsParentAlive()
    {
        var now = _startTimeOf(_parentPid);
        return now is not null && now.Value == _armedStart;
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ParentLivenessProbeTests"`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/ParentLivenessProbe.cs tests/PRism.Core.Tests/Hosting/ParentLivenessProbeTests.cs
git commit -m "feat(hosting): add recycle-resistant ParentLivenessProbe"
```

---

### Task A3: Parent-liveness watchdog hosted service

**Files:**
- Create: `PRism.Web/Hosting/ParentLivenessWatchdog.cs`
- Test: `tests/PRism.Web.Tests/Hosting/ParentLivenessWatchdogTests.cs`

- [ ] **Step 1: Write the failing test**

```csharp
using Microsoft.Extensions.Hosting;
using PRism.Core.Hosting;
using PRism.Web.Hosting;

namespace PRism.Web.Tests.Hosting;

public class ParentLivenessWatchdogTests
{
    private sealed class FakeLifetime : IHostApplicationLifetime
    {
        public bool Stopped { get; private set; }
        public CancellationToken ApplicationStarted => default;
        public CancellationToken ApplicationStopping => default;
        public CancellationToken ApplicationStopped => default;
        public void StopApplication() => Stopped = true;
    }

    [Fact]
    public async Task Watchdog_WhenParentDies_StopsApplication()
    {
        var alive = true;
        var probe = new StubProbe(() => alive);
        var lifetime = new FakeLifetime();
        var watchdog = new ParentLivenessWatchdog(probe, lifetime, pollInterval: TimeSpan.FromMilliseconds(10));

        await watchdog.StartAsync(CancellationToken.None);
        alive = false;

        // Poll the observable condition with a generous ceiling (no fixed sleep — CI-safe).
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (!lifetime.Stopped && DateTime.UtcNow < deadline)
            await Task.Delay(10);

        await watchdog.StopAsync(CancellationToken.None);
        Assert.True(lifetime.Stopped);
    }

    [Fact]
    public async Task Watchdog_WhenParentStaysAlive_DoesNotStop()
    {
        var probe = new StubProbe(() => true);
        var lifetime = new FakeLifetime();
        var watchdog = new ParentLivenessWatchdog(probe, lifetime, pollInterval: TimeSpan.FromMilliseconds(10));

        await watchdog.StartAsync(CancellationToken.None);
        var deadline = DateTime.UtcNow.AddMilliseconds(200);
        while (DateTime.UtcNow < deadline) await Task.Delay(10);
        await watchdog.StopAsync(CancellationToken.None);

        Assert.False(lifetime.Stopped);
    }

    private sealed class StubProbe : IParentLivenessProbe
    {
        private readonly Func<bool> _alive;
        public StubProbe(Func<bool> alive) => _alive = alive;
        public bool IsParentAlive() => _alive();
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~ParentLivenessWatchdogTests"`
Expected: FAIL — `ParentLivenessWatchdog` and `IParentLivenessProbe` do not exist.

- [ ] **Step 3a: Extract a probe interface (so the watchdog is testable)**

Add to `PRism.Core/Hosting/ParentLivenessProbe.cs`:

```csharp
public interface IParentLivenessProbe
{
    bool IsParentAlive();
}
```

And change the class declaration line to implement it:

```csharp
public sealed class ParentLivenessProbe : IParentLivenessProbe
```

- [ ] **Step 3b: Write the watchdog**

```csharp
using Microsoft.Extensions.Hosting;
using PRism.Core.Hosting;

namespace PRism.Web.Hosting;

/// <summary>
/// Polls a parent-liveness probe; when the launching Electron shell disappears
/// (graceful quit kills us first; this is the ungraceful-crash fallback), stops
/// the host so the sidecar never orphans. Only registered in sidecar mode.
/// Never restarts the app — self-exit only.
/// </summary>
public sealed class ParentLivenessWatchdog : BackgroundService
{
    private readonly IParentLivenessProbe _probe;
    private readonly IHostApplicationLifetime _lifetime;
    private readonly TimeSpan _pollInterval;

    public ParentLivenessWatchdog(
        IParentLivenessProbe probe,
        IHostApplicationLifetime lifetime,
        TimeSpan pollInterval)
    {
        _probe = probe;
        _lifetime = lifetime;
        _pollInterval = pollInterval;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            if (!_probe.IsParentAlive())
            {
                _lifetime.StopApplication();
                return;
            }

            try { await Task.Delay(_pollInterval, stoppingToken); }
            catch (TaskCanceledException) { return; }
        }
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~ParentLivenessWatchdogTests"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add PRism.Core/Hosting/ParentLivenessProbe.cs PRism.Web/Hosting/ParentLivenessWatchdog.cs tests/PRism.Web.Tests/Hosting/ParentLivenessWatchdogTests.cs
git commit -m "feat(hosting): add ParentLivenessWatchdog hosted service + extract IParentLivenessProbe"
```

> Note: this commit also modifies `ParentLivenessProbe.cs` (Step 3a adds the interface). Re-run the A2 probe tests after this change — they still pass (the interface adds no behavior): `dotnet test tests/PRism.Core.Tests/PRism.Core.Tests.csproj --filter "FullyQualifiedName~ParentLivenessProbeTests"`.

---

### Task A4: Host-header DNS-rebinding defense middleware

**Files:**
- Create: `PRism.Web/Middleware/HostHeaderCheckMiddleware.cs`
- Test: `tests/PRism.Web.Tests/Middleware/HostHeaderCheckMiddlewareTests.cs`

Rejects any request whose `Host` is not a loopback literal (`127.0.0.1[:port]` / `[::1]`). A DNS-rebinded page connects to the loopback socket but sends the *attacker's* domain in `Host`, so this blocks it. Active only when enforced (non-Development), same gate idiom as the other middleware.

- [ ] **Step 1: Write the failing test**

```csharp
using Microsoft.AspNetCore.Http;
using PRism.Web.Middleware;

namespace PRism.Web.Tests.Middleware;

public class HostHeaderCheckMiddlewareTests
{
    private static async Task<int> Run(string host, bool enforced)
    {
        var ctx = new DefaultHttpContext();
        ctx.Request.Headers.Host = host;
        var called = false;
        var mw = new HostHeaderCheckMiddleware(_ => { called = true; return Task.CompletedTask; }, enforced);
        await mw.InvokeAsync(ctx);
        return called ? 200 : ctx.Response.StatusCode;
    }

    [Theory]
    [InlineData("127.0.0.1:5180")]
    [InlineData("127.0.0.1")]
    [InlineData("[::1]:5180")]
    public async Task LoopbackHost_PassesThrough(string host)
        => Assert.Equal(200, await Run(host, enforced: true));

    [Theory]
    [InlineData("evil.example.com")]
    [InlineData("evil.example.com:5180")]
    [InlineData("attacker.tld")]
    public async Task NonLoopbackHost_Rejected403(string host)
        => Assert.Equal(403, await Run(host, enforced: true));

    [Fact]
    public async Task WhenNotEnforced_AllHostsPass()
        => Assert.Equal(200, await Run("evil.example.com", enforced: false));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~HostHeaderCheckMiddlewareTests"`
Expected: FAIL — `HostHeaderCheckMiddleware` does not exist.

- [ ] **Step 3: Write minimal implementation**

```csharp
using System.Net;
using Microsoft.AspNetCore.Http;

namespace PRism.Web.Middleware;

/// <summary>
/// DNS-rebinding defense for the loopback sidecar: only requests whose Host header
/// is a loopback literal are served. A rebinded page reaches the socket but carries
/// the attacker's domain in Host, so it is rejected here before auth/origin run.
/// </summary>
internal sealed class HostHeaderCheckMiddleware
{
    private readonly RequestDelegate _next;
    private readonly bool _enforced;

    public HostHeaderCheckMiddleware(RequestDelegate next, bool enforced)
    {
        _next = next;
        _enforced = enforced;
    }

    public async Task InvokeAsync(HttpContext ctx)
    {
        if (_enforced && !IsLoopbackHost(ctx.Request.Host.Host))
        {
            ctx.Response.StatusCode = StatusCodes.Status403Forbidden;
            await ctx.Response.WriteAsync("Rejected: non-loopback Host header.");
            return;
        }

        await _next(ctx);
    }

    private static bool IsLoopbackHost(string host)
    {
        if (string.IsNullOrEmpty(host)) return false;
        var h = host.Trim('[', ']'); // strip IPv6 brackets
        return IPAddress.TryParse(h, out var ip) && IPAddress.IsLoopback(ip);
    }
}
```

> Note: `ctx.Request.Host.Host` already strips the port, so the `[::1]:5180` case in the test exercises the `Host` parsing through `DefaultHttpContext`, which yields `::1`. The bracket-strip covers the literal form defensively.

- [ ] **Step 4: Run test to verify it passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~HostHeaderCheckMiddlewareTests"`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit**

```bash
git add PRism.Web/Middleware/HostHeaderCheckMiddleware.cs tests/PRism.Web.Tests/Middleware/HostHeaderCheckMiddlewareTests.cs
git commit -m "feat(security): add Host-header loopback check (DNS-rebinding defense)"
```

---

### Task A5: Wire sidecar mode into `Program.cs` (bind 127.0.0.1, watchdog, Host check)

**Files:**
- Modify: `PRism.Web/Program.cs` (production-only block, lines ~117–142, and middleware registration ~150)
- Test: `tests/PRism.Web.Tests/Hosting/SidecarLaunchContractTests.cs`

- [ ] **Step 1: Write the failing test (pin the `--dataDir` → `DataDir` config contract + health auth-exemption)**

```csharp
using Microsoft.AspNetCore.Mvc.Testing;
using PRism.Web.Tests.Infrastructure; // existing PRismWebApplicationFactory

namespace PRism.Web.Tests.Hosting;

public class SidecarLaunchContractTests : IClassFixture<PRismWebApplicationFactory>
{
    private readonly PRismWebApplicationFactory _factory;
    public SidecarLaunchContractTests(PRismWebApplicationFactory factory) => _factory = factory;

    [Fact]
    public async Task HealthEndpoint_IsReachableWithoutSession_AndReportsPort()
    {
        // /api/health is the shell's liveness gate; it MUST be auth-exempt and carry the port.
        var client = _factory.CreateClient();
        var resp = await client.GetAsync("/api/health");

        resp.EnsureSuccessStatusCode();
        var body = await resp.Content.ReadAsStringAsync();
        Assert.Contains("\"port\"", body);
        Assert.Contains("\"dataDir\"", body);
    }
}
```

> If `PRismWebApplicationFactory` is named differently, use the existing Web test factory (see `tests/PRism.Web.Tests/`); per repo convention factories override `ConfigureWebHost`, not `CreateHostBuilder`.

- [ ] **Step 2: Run test to verify it fails or passes**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj --filter "FullyQualifiedName~SidecarLaunchContractTests"`
Expected: PASS already (this pins existing behavior so a future change can't silently break the shell's liveness gate). If it FAILS, the health/auth contract regressed and must be restored before proceeding.

- [ ] **Step 3: Detect sidecar mode ONCE and register the watchdog (pre-`Build()`)**

Add this in the `builder.Services` phase, *before* `var app = builder.Build();`. Detect once into a `sidecar` variable that the whole file can use (top-level statements keep it in scope for the production block below).

```csharp
// Detect sidecar mode (Electron shell launch) once. Reused by the production block below.
var sidecar = SidecarMode.Detect(Environment.GetEnvironmentVariable);

// Guard: sidecar mode REQUIRES a valid parent PID. A process that thinks it's a
// sidecar (binds 127.0.0.1, suppresses browser launch) but has no parent to watch
// would orphan silently. The shell always passes PRISM_PARENT_PID; a missing/bad
// one means a hand-invocation — refuse rather than run watchdog-free.
if (sidecar.Enabled && sidecar.ParentPid is null)
{
    Console.Error.WriteLine("PRISM_SIDECAR=1 requires a valid PRISM_PARENT_PID. Refusing to start.");
    return;
}

if (sidecar.Enabled && sidecar.ParentPid is int parentPid)
{
    var probe = ParentLivenessProbe.Arm(parentPid, ParentLivenessProbe.StartTimeOfProcess);
    if (probe is null)
    {
        // Parent already gone before we finished starting — exit immediately, don't orphan.
        return;
    }

    builder.Services.AddHostedService(sp =>
        new ParentLivenessWatchdog(
            probe,
            sp.GetRequiredService<IHostApplicationLifetime>(),
            TimeSpan.FromSeconds(2)));
}
```

> This is the single, authoritative watchdog wiring — there is no fire-and-forget fallback. `IHostApplicationLifetime.StopApplication()` unblocks `app.Run()`, so the hosted service cleanly stops the `WebApplication`. The probe is armed pre-`Build()` (no DI needed — it only reads the parent's start-time).

- [ ] **Step 4: Modify the production block — bind 127.0.0.1, suppress browser, report port POST-bind**

Replace the production-only block (currently starting at `if (!isTest)`) with:

```csharp
// Production-only: lockfile + URL binding + browser launch.
if (!isTest)
{
    if (string.IsNullOrEmpty(explicitUrls))
    {
        app.Urls.Clear();
        // Standardize the sidecar on the 127.0.0.1 literal so the renderer's Origin,
        // the Host-header check, and the bind all agree (avoids localhost/::1 drift).
        // Browser-tab mode keeps localhost for backward compatibility.
        var host = sidecar.Enabled ? "127.0.0.1" : "localhost";
        app.Urls.Add($"http://{host}:{port}");
    }

    var binaryPath = Environment.ProcessPath ?? "PRism";
    var lockHandle = LockfileManager.Acquire(dataDir, binaryPath, Environment.ProcessId);
    app.Lifetime.ApplicationStopping.Register(() => lockHandle.Dispose());

    var reportHost = sidecar.Enabled ? "127.0.0.1" : "localhost";

    // Browser launch only in browser-tab mode. The shell passes --no-browser AND
    // PRISM_SIDECAR=1; we never auto-open a browser when wrapped by Electron.
    var noBrowser = args.Contains("--no-browser", StringComparer.OrdinalIgnoreCase) || sidecar.Enabled;

    // Report the port AFTER the server binds (ApplicationStarted), not before app.Run().
    // This guarantees the shell only ever parses a port the backend actually bound —
    // a bind failure exits the process (shell's child-exit handler fails fast) instead
    // of printing a phantom port the shell would health-poll until timeout.
    app.Lifetime.ApplicationStarted.Register(() =>
    {
        Console.WriteLine($"PRism listening on http://{reportHost}:{port} (dataDir: {dataDir})");
        if (!noBrowser)
        {
            var launcher = new BrowserLauncher(new SystemProcessRunner(), BrowserLauncher.CurrentPlatform());
            launcher.Launch($"http://localhost:{port}");
        }
    });
}
```

> Note: the original code printed the listening line *before* `app.Run()` (which is what binds Kestrel). Moving it into `ApplicationStarted` is the fail-fast fix from review — a port is reported only on a successful bind.

- [ ] **Step 5: Register the Host-header middleware (sidecar-gated) first in the loopback pipeline**

Just before `app.UseMiddleware<OriginCheckMiddleware>();` add:

```csharp
// DNS-rebinding defense for the loopback sidecar. The threat (a rebinded page
// reaching the 127.0.0.1 socket) only exists in sidecar mode, so gate on it — NOT
// on !IsDevelopment() alone, which would 403 a reverse-proxied Host in browser-tab
// production. Runs before Origin/session checks (reject rebinding cheapest-first).
app.UseMiddleware<HostHeaderCheckMiddleware>(sidecar.Enabled && !app.Environment.IsDevelopment());
```

- [ ] **Step 6: Build + run the full Web test suite**

Run: `dotnet test tests/PRism.Web.Tests/PRism.Web.Tests.csproj`
Expected: PASS (all existing tests + the new contract test). The Host-header middleware must not break existing tests — they use `DefaultHttpContext`/TestServer whose Host is `localhost`, a loopback literal, so they pass.

> If existing tests send a non-loopback Host (unlikely), gate the middleware to `sidecar.Enabled` instead of `!IsDevelopment()`. Verify by running the suite; if green as written, keep the broader gate.

- [ ] **Step 7: Commit**

```bash
git add PRism.Web/Program.cs tests/PRism.Web.Tests/Hosting/SidecarLaunchContractTests.cs
git commit -m "feat(hosting): wire sidecar mode — 127.0.0.1 bind, watchdog, Host-header check"
```

- [ ] **Step 8: Pre-push checklist + open the Phase-A PR(s) to `main`**

Run the full pre-push checklist (`.ai/docs/development-process.md`): `dotnet build --configuration Release`, `dotnet test`, frontend `npm run lint` + `npm run build` (no frontend change here, but the checklist is non-optional). Then publish via `pr-autopilot` targeting `main`.

> Phase-A tasks A1–A5 may ship as one PR ("backend sidecar seams") or split A4 (security) out; implementer's call. They must merge to `main` before Phase D's e2e can run against a real sidecar.

---

## PHASE B — Electron shell scaffold + lifecycle (`desktop` branch)

### Task B1: `desktop/` scaffold + blank-window smoke

**Files:**
- Create: `desktop/package.json`, `desktop/tsconfig.json`, `desktop/.gitignore`, `desktop/src/main.ts`

- [ ] **Step 1: Create `desktop/package.json`**

```json
{
  "name": "prism-desktop",
  "version": "0.2.0",
  "description": "PRism Electron desktop shell",
  "main": "dist/main.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "npm run build && electron .",
    "test:unit": "tsc -p tsconfig.test.json && node --test dist-test/test/",
    "test:e2e": "playwright test",
    "dist": "npm run build && electron-builder"
  },
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^25.0.0",
    "typescript": "^5.6.0",
    "@playwright/test": "^1.48.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: Create `desktop/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "moduleResolution": "Node",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2b: Create `desktop/tsconfig.test.json` (compiles src + test for unit tests)**

The main `tsconfig.json` `include` is `src/**/*` only, so it will NOT compile test files. Unit tests need their own config that includes `test/`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "outDir": "dist-test",
    "rootDir": "."
  },
  "include": ["src/**/*.ts", "test/**/*.ts"]
}
```

- [ ] **Step 3: Create `desktop/.gitignore`**

```
node_modules/
dist/
dist-test/
release/
```

- [ ] **Step 4: Create a minimal `desktop/src/main.ts` (blank window)**

```typescript
import { app, BrowserWindow } from "electron";

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void win.loadURL("about:blank");
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  app.quit();
});
```

- [ ] **Step 5: Install + smoke**

Run:
```bash
cd desktop && npm install && npm run start
```
Expected: an Electron window opens showing a blank page. Close it; the process exits. (Manual smoke — packaging/automation comes later.)

- [ ] **Step 6: Commit**

```bash
git add desktop/package.json desktop/tsconfig.json desktop/.gitignore desktop/src/main.ts desktop/package-lock.json
git commit -m "feat(desktop): scaffold Electron shell with blank window"
```

---

### Task B2: Port-parse + health-poll pure helpers (unit-tested)

**Files:**
- Create: `desktop/src/ports.ts`
- Create: `desktop/test/ports.unit.test.ts`

- [ ] **Step 1: Write the failing unit test**

```typescript
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePortFromLine } from "../src/ports";

test("parsePortFromLine extracts the port from the listening line", () => {
  const line = "PRism listening on http://127.0.0.1:5183 (dataDir: /home/u/.prism)";
  assert.equal(parsePortFromLine(line), 5183);
});

test("parsePortFromLine returns null for unrelated lines", () => {
  assert.equal(parsePortFromLine("some other log line"), null);
});

test("parsePortFromLine handles localhost host form too", () => {
  assert.equal(parsePortFromLine("PRism listening on http://localhost:5180 (dataDir: x)"), 5180);
});
```

- [ ] **Step 2: Compile tests + run to verify failure**

Run:
```bash
cd desktop && npm run test:unit
```
(Which runs `tsc -p tsconfig.test.json && node --test dist-test/test/`.)
Expected: FAIL — `parsePortFromLine` not found (compile error from the test importing a missing export).

- [ ] **Step 3: Implement `desktop/src/ports.ts`**

```typescript
/** Parse the bound port out of the sidecar's "PRism listening on http://<host>:<port>" stdout line. */
export function parsePortFromLine(line: string): number | null {
  const m = line.match(/PRism listening on https?:\/\/[^:]+:(\d+)/);
  return m ? Number(m[1]) : null;
}

/** Poll GET <baseUrl>/api/health until 200 or timeout. Returns true on success. */
export async function pollHealth(
  baseUrl: string,
  timeoutMs: number,
  intervalMs = 200,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetchFn(`${baseUrl}/api/health`);
      if (res.ok) return true;
    } catch {
      // sidecar not up yet
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
```

- [ ] **Step 4: Re-run tests to verify pass**

Run:
```bash
cd desktop && npm run test:unit
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add desktop/src/ports.ts desktop/test/ports.unit.test.ts
git commit -m "feat(desktop): add port-parse + health-poll helpers with unit tests"
```

---

### Task B3: Sidecar spawn + lifecycle module

**Files:**
- Create: `desktop/src/sidecar.ts`

- [ ] **Step 1: Implement `desktop/src/sidecar.ts`**

```typescript
import { spawn, ChildProcess } from "node:child_process";
import { parsePortFromLine, pollHealth } from "./ports";

export interface Sidecar {
  baseUrl: string;
  stop(): Promise<void>;
}

export interface SidecarOptions {
  binaryPath: string;
  dataDir: string;
  parentPid: number;
  startTimeoutMs?: number;
}

/**
 * Spawn the PRism.Web sidecar, learn its port from stdout, health-gate, and return
 * a handle. The backend picks its own free port (no shell-side TOCTOU); we read it.
 */
export async function startSidecar(opts: SidecarOptions): Promise<Sidecar> {
  const child: ChildProcess = spawn(
    opts.binaryPath,
    ["--no-browser", "--dataDir", opts.dataDir],
    {
      // Pass a MINIMAL explicit env — do NOT spread process.env. Spreading would
      // hand the sidecar every ambient variable (incl. any CI secrets like
      // GITHUB_TOKEN inherited by the Electron process). The sidecar needs only
      // PATH + a temp dir + the two sidecar signals.
      env: {
        PATH: process.env.PATH ?? "",
        ...(process.platform === "win32"
          ? { SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? "", USERPROFILE: process.env.USERPROFILE ?? "" }
          : { HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "" }),
        PRISM_SIDECAR: "1",
        PRISM_PARENT_PID: String(opts.parentPid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const port = await readPortFromStdout(child, opts.startTimeoutMs ?? 15000);
  const baseUrl = `http://127.0.0.1:${port}`;

  const healthy = await pollHealth(baseUrl, opts.startTimeoutMs ?? 15000);
  if (!healthy) {
    child.kill();
    throw new Error("PRism backend failed its health check.");
  }

  return {
    baseUrl,
    stop: () => stopChild(child),
  };
}

function readPortFromStdout(child: ChildProcess, timeoutMs: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for backend port.")), timeoutMs);
    let buf = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        const port = parsePortFromLine(line);
        if (port !== null) {
          clearTimeout(timer);
          resolve(port);
          return;
        }
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Backend exited before reporting a port (code ${code}).`));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  return new Promise((resolve) => {
    const force = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(force);
      resolve();
    });
    // SIGTERM on Unix; on Windows .kill() maps to TerminateProcess.
    child.kill("SIGTERM");
  });
}
```

- [ ] **Step 2: Build to verify it compiles**

Run: `cd desktop && npm run build`
Expected: `tsc` exits 0, `dist/sidecar.js` produced.

- [ ] **Step 3: Commit**

```bash
git add desktop/src/sidecar.ts
git commit -m "feat(desktop): add sidecar spawn + port handshake + graceful teardown"
```

---

### Task B4: Wire main process — single-instance, spawn, window, quit

**Files:**
- Modify: `desktop/src/main.ts`

- [ ] **Step 1: Replace `desktop/src/main.ts` with the full lifecycle**

```typescript
import { app, BrowserWindow, dialog } from "electron";
import * as path from "node:path";
import * as os from "node:os";
import { startSidecar, Sidecar } from "./sidecar";

let sidecar: Sidecar | null = null;
let mainWindow: BrowserWindow | null = null;

// Single-instance gate FIRST — before spawning any backend.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(bootstrap);

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", async (e) => {
    if (sidecar) {
      e.preventDefault();
      const s = sidecar;
      sidecar = null;
      await s.stop();
      app.quit();
    }
  });
}

function resolveBinaryPath(): string {
  const exe = process.platform === "win32" ? "PRism-win-x64.exe" : "PRism-osx-arm64";
  // Packaged: extraResources under process.resourcesPath. Dev: env override.
  const fromEnv = process.env.PRISM_SIDECAR_BINARY;
  if (fromEnv) return fromEnv;
  return path.join(process.resourcesPath, "sidecar", exe);
}

function resolveDataDir(): string {
  // Mirror the backend's default user-profile location; overridable for dev.
  return process.env.PRISM_DATA_DIR ?? path.join(os.homedir(), ".prism");
}

async function bootstrap(): Promise<void> {
  try {
    sidecar = await startSidecar({
      binaryPath: resolveBinaryPath(),
      dataDir: resolveDataDir(),
      parentPid: process.pid,
    });
  } catch (err) {
    dialog.showErrorBox("PRism failed to start", String(err));
    app.quit();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(sidecar.baseUrl);
}
```

- [ ] **Step 2: Build + manual smoke against a dev backend**

Build a sidecar binary once:
```bash
cd .. && dotnet publish PRism.Web/PRism.Web.csproj --runtime win-x64 --self-contained -p:PublishProfile=ci --output desktop/dev-sidecar
```
Run the shell pointed at it. For the **dev smoke, point `PRISM_SIDECAR_BINARY` directly at the unrenamed published binary** (`PRism.Web.exe`) — the per-RID rename to `PRism-win-x64.exe` happens only in CI (Task C2), so don't replicate it here:
```powershell
cd desktop ; $env:PRISM_SIDECAR_BINARY="$PWD\dev-sidecar\PRism.Web.exe" ; npm run start
```
(macOS/Linux: `PRISM_SIDECAR_BINARY="$PWD/dev-sidecar/PRism.Web" npm run start`.)
Expected: the PRism app loads in the Electron window (Inbox / paste-PAT screen). Launch a second `npm run start` → no second window, the first focuses. Close → no orphaned `PRism.Web` process (check Task Manager / `ps`).

- [ ] **Step 3: Commit**

```bash
git add desktop/src/main.ts
git commit -m "feat(desktop): single-instance, sidecar bootstrap, window load, clean quit"
```

---

## PHASE C — Packaging + CI (`desktop` branch)

### Task C1: Icons + electron-builder config

**Files:**
- Create: `desktop/assets/icons/icon.png` (1024×1024), `icon.ico`, `icon.icns` (derived from existing `assets/icons/` source via the S6 sharp pipeline or an icon tool)
- Create: `desktop/electron-builder.yml`

- [ ] **Step 1: Produce icon assets**

Derive from the existing 256×256 source in repo `assets/icons/`. Use an icon generator (e.g. `npx @bitdisaster/exe-icon-extractor` is not it — use `electron-icon-builder` or `png2icons`):
```bash
cd desktop && npx png2icons assets/icons/icon.png assets/icons/icon -allp
```
Expected: `icon.ico` + `icon.icns` generated next to `icon.png`.

- [ ] **Step 2: Create `desktop/electron-builder.yml`**

```yaml
appId: com.prism.desktop
productName: PRism
directories:
  output: release
files:
  - dist/**/*
  - package.json
extraResources:
  - from: sidecar
    to: sidecar
win:
  target:
    - portable
    - nsis
  icon: assets/icons/icon.ico
mac:
  target:
    - dmg
  arch:
    - arm64
  icon: assets/icons/icon.icns
  # No identity → electron-builder applies an ad-hoc signature. No notarization.
  identity: null
nsis:
  oneClick: false
  perMachine: false
  allowToChangeInstallationDirectory: true
```

> `extraResources` expects the renamed per-RID binary in `desktop/sidecar/` at pack time. The CI job (Task C2) publishes the sidecar into `desktop/sidecar/` before invoking electron-builder.

- [ ] **Step 3: Local unsigned Windows pack smoke**

```bash
cd .. && dotnet publish PRism.Web/PRism.Web.csproj --runtime win-x64 --self-contained -p:PublishProfile=ci --output desktop/sidecar
cd desktop && (Move-Item sidecar/PRism.Web.exe sidecar/PRism-win-x64.exe) ; npm run dist
```
(PowerShell rename shown; bash: `mv sidecar/PRism.Web.exe sidecar/PRism-win-x64.exe`.)
Expected: `desktop/release/` contains an unsigned `PRism <version>.exe` (portable) and an NSIS installer. Run the portable exe → SmartScreen warning → More info → Run anyway → app launches.

- [ ] **Step 4: Commit**

```bash
git add desktop/assets/icons desktop/electron-builder.yml
git commit -m "feat(desktop): icons + electron-builder config (unsigned win/mac)"
```

---

### Task C2: CI matrix workflow (`v0.2.*` tags)

**Files:**
- Create: `.github/workflows/publish-desktop.yml`

- [ ] **Step 1: Create the workflow**

```yaml
name: Publish Desktop

on:
  workflow_dispatch:
    inputs:
      tag:
        description: 'Release tag (e.g., v0.2.0)'
        required: true
        type: string
      include_macos:
        description: 'Build + attach the macOS .dmg (only if a Mac tester is confirmed).'
        required: false
        type: boolean
        default: false

permissions:
  contents: write

jobs:
  build:
    strategy:
      matrix:
        include:
          - os: windows-latest
            rid: win-x64
            binary: PRism-win-x64.exe       # final name electron-builder packs
            dotnet_binary: PRism.Web.exe     # raw `dotnet publish` output (pre-rename)
          - os: macos-latest
            rid: osx-arm64
            binary: PRism-osx-arm64
            dotnet_binary: PRism.Web
    runs-on: ${{ matrix.os }}
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd  # v6.0.2
      - uses: actions/setup-dotnet@c2fa09f4bde5ebb9d1777cf28262a3eb3db3ced7  # v5.2.0
        with:
          dotnet-version: '10.0.x'
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e  # v6.4.0
        with:
          node-version: '24'

      - name: Skip macOS unless requested
        if: matrix.os == 'macos-latest' && inputs.include_macos != true
        shell: bash
        run: echo "SKIP_JOB=1" >> "$GITHUB_ENV"

      - name: Frontend install + build
        if: env.SKIP_JOB != '1'
        working-directory: frontend
        run: npm ci && npm run build

      - name: Publish sidecar
        if: env.SKIP_JOB != '1'
        run: >
          dotnet publish PRism.Web/PRism.Web.csproj
          --runtime ${{ matrix.rid }} --self-contained --configuration Release
          -p:PublishProfile=ci --output desktop/sidecar

      - name: Rename sidecar binary
        if: env.SKIP_JOB != '1'
        shell: bash
        run: mv "desktop/sidecar/${{ matrix.dotnet_binary }}" "desktop/sidecar/${{ matrix.binary }}"

      - name: Desktop install + pack
        if: env.SKIP_JOB != '1'
        working-directory: desktop
        run: npm ci && npm run dist

      - name: Upload to draft Release
        if: env.SKIP_JOB != '1'
        uses: softprops/action-gh-release@b4309332981a82ec1c5618f44dd2e27cc8bfbfda  # v3.0.0
        with:
          tag_name: ${{ inputs.tag }}
          draft: true
          # Newline-separated explicit globs — the proven idiom in this repo's
          # publish.yml. Avoid bash extglob (@(exe|dmg)), which action-gh-release
          # does not reliably evaluate.
          files: |
            desktop/release/*.exe
            desktop/release/*.dmg
```

> Action SHAs match the repo's existing pins (`publish.yml`); bump via Dependabot. This fires only on `workflow_dispatch` with a `v0.2.*` tag; the existing `publish.yml` still owns `v0.1.*`, preserving the browser-tab fallback artifact.

- [ ] **Step 2: Validate workflow YAML**

Run: `cd .. && gh workflow view "Publish Desktop" 2>/dev/null || echo "view after push"` — or lint locally with `actionlint .github/workflows/publish-desktop.yml` if available.
Expected: no syntax errors. (End-to-end dispatch is exercised at release time, not in this task — it needs the branch on `main`/a dispatch-eligible ref.)

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/publish-desktop.yml
git commit -m "ci(desktop): add v0.2.* matrix publish workflow (win + opt-in mac)"
```

---

## PHASE D — e2e, TESTING.md, docs (`desktop` branch)

### Task D1: Playwright `_electron` e2e smoke suite

**Files:**
- Create: `desktop/playwright.config.ts`
- Create: `desktop/test/shell.e2e.ts`

- [ ] **Step 1: Create `desktop/playwright.config.ts`**

```typescript
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: /.*\.e2e\.ts/,
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
```

- [ ] **Step 2: Write the e2e suite**

```typescript
import { test, expect, _electron as electron, ElectronApplication } from "@playwright/test";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

const SIDECAR = process.env.PRISM_SIDECAR_BINARY!; // set by the runner to the published binary
const MAIN = path.join(__dirname, "..", "dist", "main.js");

function launchEnv(dataDir: string) {
  return { PRISM_SIDECAR_BINARY: SIDECAR, PRISM_DATA_DIR: dataDir };
}

async function launch(dataDir: string): Promise<ElectronApplication> {
  return electron.launch({ args: [MAIN], env: { ...process.env, ...launchEnv(dataDir) } });
}

test("window opens and loads the app from the sidecar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-e2e-"));
  const app = await launch(dir);
  const win = await app.firstWindow();
  // The app renders against the loopback sidecar; the health-gated load means the
  // document title / a known root element is present.
  await expect(win.locator("body")).toBeVisible();
  const url = win.url();
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
  await app.close();
});

test("session handshake: prism-session cookie present and echoed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-e2e-"));
  const app = await launch(dir);
  const win = await app.firstWindow();
  await win.waitForLoadState("networkidle");
  const cookies = await win.context().cookies();
  expect(cookies.some((c) => c.name === "prism-session")).toBe(true);
  await app.close();
});

test("single-instance: second launch does not open a second window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-e2e-"));
  const first = await launch(dir);
  await first.firstWindow();

  const second = await launch(dir);
  // The second instance should fail the lock and quit; assert it produces no window.
  let secondWindowOpened = false;
  second.on("window", () => { secondWindowOpened = true; });
  // Give the second process a bounded chance to (not) open a window.
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline && !secondWindowOpened) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(secondWindowOpened).toBe(false);
  await second.close().catch(() => {});
  await first.close();
});

test("clean quit leaves no orphaned sidecar process", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prism-e2e-"));
  const app = await launch(dir);
  await app.firstWindow();
  await app.close();

  // Assert the actual sidecar PROCESS is gone — not the lockfile. On Windows,
  // child.kill() maps to TerminateProcess, which does NOT run .NET's graceful
  // ApplicationStopping, so LockfileHandle.Dispose never deletes state.json.lock.
  // The lockfile may legitimately persist after an abrupt kill (the next launch's
  // IsAlive PID+binary takeover handles it); the orphan tell is a live process.
  const exeName = process.platform === "win32" ? "PRism-win-x64.exe" : "PRism-osx-arm64";
  const deadline = Date.now() + 5000;
  while (sidecarProcessRunning(exeName) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 100));
  }
  expect(sidecarProcessRunning(exeName)).toBe(false);
});

function sidecarProcessRunning(exeName: string): boolean {
  const { execSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, { encoding: "utf8" });
      return out.includes(exeName);
    }
    const out = execSync(`pgrep -f ${exeName} || true`, { encoding: "utf8" });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}
```

> The orphan assertion checks the live **process**, not the lockfile. A stale lockfile after an abrupt Windows kill is benign (next-launch `IsAlive` takeover handles it); a surviving process is the real orphan. This is the fix for the feasibility finding that `TerminateProcess` skips `.NET` graceful shutdown.

- [ ] **Step 3: Run the e2e suite locally (needs the PUBLISHED sidecar)**

The e2e MUST run against the **published, self-contained binary** (which defaults to the `Production` environment), NOT a `dotnet run` sidecar. In Development the `SessionTokenMiddleware` and `HostHeaderCheckMiddleware` are bypassed, so the session-handshake and rebinding behaviors would pass for the wrong reason. The published binary has no `ASPNETCORE_ENVIRONMENT` set → Production → enforced.

Run from the `desktop` directory (the env var uses an absolute path so it works regardless of cwd):
```powershell
cd .. ; dotnet publish PRism.Web/PRism.Web.csproj --runtime win-x64 --self-contained -p:PublishProfile=ci --output desktop/sidecar
cd desktop ; Move-Item sidecar/PRism.Web.exe sidecar/PRism-win-x64.exe
npm run build
$env:PRISM_SIDECAR_BINARY="$PWD\sidecar\PRism-win-x64.exe" ; npx playwright test
```
(bash, run from `desktop/`: `PRISM_SIDECAR_BINARY="$(pwd)/sidecar/PRism-win-x64.exe" npx playwright test`.)
Expected: 4 tests PASS.

- [ ] **Step 4: Commit**

```bash
git add desktop/playwright.config.ts desktop/test/shell.e2e.ts
git commit -m "test(desktop): Playwright _electron e2e — load, session, single-instance, no-orphan"
```

---

### Task D2: `TESTING.md`

**Files:**
- Create: `TESTING.md` (repo root)

- [ ] **Step 1: Write `TESTING.md`**

```markdown
# Testing PRism (desktop preview builds)

PRism's desktop builds are **unsigned** preview binaries for hands-on testing. Your OS
will warn you the first time you run them — that's expected for an unsigned app, not a
sign anything is wrong. Steps below get you past it.

There is **no auto-update**. To update, download the latest build and reinstall.

## Windows

1. Download `PRism <version>.exe` (portable) from the release.
2. Double-click. Windows SmartScreen shows "Windows protected your PC."
3. Click **More info** → **Run anyway**.
4. PRism opens. Paste your GitHub PAT to begin.

If your machine is managed by your employer (Intune/MDM) and "Run anyway" is missing or
blocked, your IT policy is blocking unsigned apps — ask the maintainer for the browser-tab
build instead.

## macOS (Apple Silicon)

1. Download `PRism-<version>-arm64.dmg`, open it, drag PRism to Applications.
2. First launch: macOS says *"Apple could not verify 'PRism' is free of malware."*
   - **macOS Sonoma (14) or earlier:** Control-click the app → **Open** → **Open**.
   - **macOS Sequoia (15) or later:** **System Settings → Privacy & Security →** scroll to the
     PRism prompt → **Open Anyway** → authenticate.
3. If you instead see *"PRism is damaged and can't be opened"*, clear the quarantine flag in
   Terminal, then reopen:
   ```
   xattr -dr com.apple.quarantine /Applications/PRism.app
   ```
4. PRism opens. Paste your GitHub PAT to begin.

## Where is my data?

PRism stores state and logs under your home directory (`~/.prism` by default). Logs are in
`~/.prism/logs/`. To recover a lost draft, see the identity-change events there.
```

- [ ] **Step 2: Commit**

```bash
git add TESTING.md
git commit -m "docs: add TESTING.md for unsigned desktop preview builds"
```

---

### Task D3: Update spec index + roadmap

**Files:**
- Modify: `docs/specs/README.md` (add the spec under "In progress")
- Modify: `docs/roadmap.md` (add a v0.2.0 desktop-shell row; note it resolves the architectural-readiness single-instance row + v1 Phase 1)

- [ ] **Step 1: Add the spec to `docs/specs/README.md` "In progress"**

Add this bullet under the `## In progress` section:

```markdown
- [`2026-06-02-electron-desktop-shell-design.md`](2026-06-02-electron-desktop-shell-design.md) — v0.2.0 Electron desktop shell: Electron main + .NET sidecar (spawn, stdout-port handshake, `/api/health` gate, sandboxed `BrowserWindow` on `127.0.0.1`), single-instance via `requestSingleInstanceLock` (closes the deferred Phase 1 single-instance data-loss path), recycle-resistant parent-liveness watchdog, Host-header DNS-rebinding defense, unsigned cross-platform installers + `TESTING.md`, `v0.2.*` matrix publish workflow. Deferrals: [`2026-06-02-electron-desktop-shell-deferrals.md`](2026-06-02-electron-desktop-shell-deferrals.md). Plan: [`../plans/2026-06-02-electron-desktop-shell.md`](../plans/2026-06-02-electron-desktop-shell.md). In progress.
```

- [ ] **Step 2: Update the single-instance row in `docs/roadmap.md`**

Find the architectural-readiness table row whose **Item** is "Single-instance enforcement (named mutex / `flock` + IPC focus signal)" and whose status cell currently ends with the v1-deferral note (`… open — design seed in … v1 deferral recorded in …`). Append to that status cell:

> `**Resolved in v0.2.0** by the Electron desktop shell ([`specs/2026-06-02-electron-desktop-shell-design.md`](./specs/2026-06-02-electron-desktop-shell-design.md)) — Electron's requestSingleInstanceLock() prevents the accidental second launch; the retained backend lockfile guards dataDir integrity.`

Do not delete the existing history in the cell — append, preserving the deferral trail. Leave the **Gate** column as-is (`Before P0+`).

- [ ] **Step 3: Commit**

```bash
git add docs/specs/README.md docs/roadmap.md
git commit -m "docs: index the Electron desktop shell spec + roadmap row"
```

- [ ] **Step 4: Pre-push checklist + open the `desktop` → `main` PR (v0.2.0)**

Run the full pre-push checklist. Confirm: all `dotnet test` green, `desktop` unit + e2e green on Windows, the § 8.1 real-Mac smoke done if macOS is included. Publish via `pr-autopilot`.

---

## Self-review against the spec

- **Goal A (own window/icon/single-window):** Tasks B1, B4, C1 (icon), D1 (window-open + single-instance e2e). ✓
- **Goal B (single-instance, data-loss fix):** B4 (`requestSingleInstanceLock` + focus), A5 (lockfile retained, 127.0.0.1 bind), D1 (single-instance + no-orphan e2e). ✓
- **Goal D (bundled Chromium):** inherent to Electron (B1). ✓
- **Additive-shell invariant:** no app-domain code changed; Phase A seams are sidecar-gated; existing tests run in A5 Step 6. ✓
- **Sidecar lifecycle / stdout-port handshake / `/api/health` gate:** B2, B3, A5 (health contract). ✓ (Backend owns port → no TOCTOU; matches spec § 3.4.)
- **Watchdog (recycle-resistant, env-var-gated, ordering):** A2, A3, A5. ✓
- **Host-header DNS-rebinding defense + 127.0.0.1 standardization:** A4, A5. ✓
- **Unsigned cross-platform packaging + coexistence with `publish.yml`:** C1, C2 (`v0.2.*` gate). ✓
- **TESTING.md:** D2. ✓
- **e2e (load, single-instance, no-orphan, session-handshake):** D1. ✓
- **macOS-tester gate / real-Mac smoke (§ 8.0/8.1):** C2 `include_macos` default false; D3 Step 4 gate. ✓
- **Docs wiring (§ 13):** D3. ✓

**Placeholder scan:** none — every code/config step carries full content.
**Type consistency:** `SidecarMode`, `ParentLivenessProbe`/`IParentLivenessProbe`, `ParentLivenessWatchdog`, `startSidecar`/`Sidecar`, `parsePortFromLine`/`pollHealth` are defined before use and referenced consistently.

**Known approximations the implementer must confirm at execution (not placeholders — they depend on live repo state):**
- The Web test factory class name in A5 Step 1 (`PRismWebApplicationFactory`) — use whatever the existing `tests/PRism.Web.Tests/` factory is named (override `ConfigureWebHost`, not `CreateHostBuilder`).
- Exact line ranges in `Program.cs` shift as the file evolves; anchor on the `if (!isTest)` block and the middleware registration sequence, not line numbers.
- Electron / electron-builder major versions in B1 — pin to the latest stable at execution; the config shape is version-stable.

---

## Execution handoff

Plan complete and saved to `docs/plans/2026-06-02-electron-desktop-shell.md`.
