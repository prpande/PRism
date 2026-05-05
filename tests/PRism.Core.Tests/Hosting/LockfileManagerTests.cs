using PRism.Core.Hosting;
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
