using System.Text.Json;
using PRism.Core.Hosting;
using PRism.Core.Json;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Hosting;

public class LockfileManagerTests
{
    [Fact]
    public void Acquire_succeeds_when_no_lockfile_exists()
    {
        using var dir = new TempDataDir();
        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
        File.Exists(Path.Combine(dir.Path, "state.json.lock")).Should().BeTrue();
    }

    [Fact]
    public void Acquire_throws_when_another_live_PRism_holds_the_lock()
    {
        using var dir = new TempDataDir();
        var ourBinary = Environment.ProcessPath ?? "PRism";
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            $"{{\"pid\":{Environment.ProcessId},\"binary-path\":\"{ourBinary.Replace("\\", "\\\\", StringComparison.Ordinal)}\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");

        Action act = () => LockfileManager.Acquire(dir.Path, currentBinaryPath: ourBinary, currentPid: Environment.ProcessId + 1);
        act.Should().Throw<LockfileException>()
            .Where(e => e.Reason == LockfileFailure.AnotherInstanceRunning);
    }

    [Fact]
    public void Acquire_recovers_from_dead_PID()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            "{\"pid\":99999999,\"binary-path\":\"/old/PRism\",\"started-at\":\"2026-05-05T12:00:00Z\"}");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
    }

    [Fact]
    public void Acquire_recovers_from_PID_alive_but_different_binary()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            $"{{\"pid\":{Environment.ProcessId},\"binary-path\":\"/totally/different/binary\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: Environment.ProcessId + 1);
    }

    // Regression for #107: a live PID whose REAL executable differs from the locked
    // binary-path, in the relaunch case where locked path == current path. On main,
    // IsAlive compares the two equal metadata strings and never inspects the real
    // process, so it falsely reports "already running (PID N)". The test runner is a
    // guaranteed-live PID standing in for the unrelated process the OS recycled the
    // dead PRism's PID into.
    [Fact]
    public void Acquire_recovers_from_recycled_PID_when_locked_path_equals_current_path()
    {
        using var dir = new TempDataDir();
        var fakePrismPath = OperatingSystem.IsWindows()
            ? @"C:\fake\PRism\PRism.Web.exe"
            : "/fake/PRism/PRism.Web";
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"),
            $"{{\"pid\":{Environment.ProcessId},\"binary-path\":\"{fakePrismPath.Replace("\\", "\\\\", StringComparison.Ordinal)}\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");

        // Relaunch of the same binary path -> locked == current. The live process at
        // this PID is the test host, not PRism, so Acquire must take over, not throw.
        var newPid = Environment.ProcessId + 1;
        using var handle = LockfileManager.Acquire(dir.Path, currentBinaryPath: fakePrismPath, currentPid: newPid);
        ReadLockPid(dir.Path).Should().Be(newPid); // proves take-over rewrote the lock
    }

    // ---- #107 seam-based liveness cases (injected fake probe) ----

    [Fact]
    public void Acquire_takes_over_when_live_PID_has_different_real_path()
    {
        using var dir = new TempDataDir();
        WriteLock(dir.Path, pid: 4242, binaryPath: "/locked/PRism");
        // Probe reports a live process whose real exe differs from the locked path.
        Func<int, RunningProcessInfo?> probe = _ => new RunningProcessInfo("/some/other/process");

        using var handle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/locked/PRism", currentPid: 9999, probeProcess: probe);
        ReadLockPid(dir.Path).Should().Be(9999);
    }

    [Fact]
    public void Acquire_throws_when_live_PID_real_path_matches_locked()
    {
        using var dir = new TempDataDir();
        WriteLock(dir.Path, pid: 4242, binaryPath: "/locked/PRism");
        Func<int, RunningProcessInfo?> probe = _ => new RunningProcessInfo("/locked/PRism");

        Action act = () => LockfileManager.Acquire(dir.Path, currentBinaryPath: "/locked/PRism", currentPid: 9999, probeProcess: probe);
        act.Should().Throw<LockfileException>().Where(e => e.Reason == LockfileFailure.AnotherInstanceRunning);
    }

    [Fact]
    public void Acquire_throws_when_live_PID_real_path_matches_locked_case_insensitively()
    {
        using var dir = new TempDataDir();
        WriteLock(dir.Path, pid: 4242, binaryPath: "/locked/PRism");
        // Path matching is OrdinalIgnoreCase (Windows is case-insensitive): a real path
        // that differs only by case is still the same PRism -> refuse.
        Func<int, RunningProcessInfo?> probe = _ => new RunningProcessInfo("/LOCKED/prism");

        Action act = () => LockfileManager.Acquire(dir.Path, currentBinaryPath: "/locked/PRism", currentPid: 9999, probeProcess: probe);
        act.Should().Throw<LockfileException>().Where(e => e.Reason == LockfileFailure.AnotherInstanceRunning);
    }

    [Fact]
    public void Acquire_throws_when_live_PID_identity_unreadable()
    {
        using var dir = new TempDataDir();
        WriteLock(dir.Path, pid: 4242, binaryPath: "/locked/PRism");
        // Alive but the real path could not be read (access denied / unsupported) ->
        // conservative refuse, no new double-run window (#107 ambiguous-case policy).
        Func<int, RunningProcessInfo?> probe = _ => new RunningProcessInfo(null);

        Action act = () => LockfileManager.Acquire(dir.Path, currentBinaryPath: "/locked/PRism", currentPid: 9999, probeProcess: probe);
        act.Should().Throw<LockfileException>().Where(e => e.Reason == LockfileFailure.AnotherInstanceRunning);
    }

    [Fact]
    public void Acquire_takes_over_when_probe_reports_dead_PID()
    {
        using var dir = new TempDataDir();
        WriteLock(dir.Path, pid: 4242, binaryPath: "/locked/PRism");
        Func<int, RunningProcessInfo?> probe = _ => null;

        using var handle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/locked/PRism", currentPid: 9999, probeProcess: probe);
        ReadLockPid(dir.Path).Should().Be(9999);
    }

    private static void WriteLock(string dataDir, int pid, string binaryPath)
    {
        File.WriteAllText(Path.Combine(dataDir, "state.json.lock"),
            $"{{\"pid\":{pid},\"binary-path\":\"{binaryPath.Replace("\\", "\\\\", StringComparison.Ordinal)}\",\"started-at\":\"2026-05-05T12:00:00Z\"}}");
    }

    private static int ReadLockPid(string dataDir)
    {
        var json = File.ReadAllText(Path.Combine(dataDir, "state.json.lock"));
        return JsonSerializer.Deserialize<LockfileRecord>(json, JsonSerializerOptionsFactory.Storage)!.Pid;
    }

    [Fact]
    public void Acquire_recovers_from_torn_json()
    {
        using var dir = new TempDataDir();
        File.WriteAllText(Path.Combine(dir.Path, "state.json.lock"), "{ broken");

        using var lockHandle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
    }

    [Fact]
    public void Dispose_removes_the_lockfile()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "state.json.lock");
        var handle = LockfileManager.Acquire(dir.Path, currentBinaryPath: "/path/to/PRism", currentPid: 12345);
        File.Exists(path).Should().BeTrue();
        handle.Dispose();
        File.Exists(path).Should().BeFalse();
    }
}
