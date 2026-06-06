using System.ComponentModel;
using System.Diagnostics;
using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.Hosting;

public sealed class LockfileHandle : IDisposable
{
    private readonly string _path;
    public LockfileHandle(string path) { _path = path; }
    public void Dispose()
    {
        try { File.Delete(_path); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed record LockfileRecord(int Pid, string BinaryPath, DateTime StartedAt);

/// <summary>
/// Identity of the live process behind a PID, as resolved by the liveness probe.
/// A <c>null</c> probe result means no live process owns that PID (dead / recycled
/// away). A non-null record with a <c>null</c> <see cref="ExecutablePath"/> means the
/// process is alive but its real executable path could not be read (access denied,
/// cross-bitness, or unsupported platform).
/// </summary>
public sealed record RunningProcessInfo(string? ExecutablePath);

public static class LockfileManager
{
    public static LockfileHandle Acquire(
        string dataDir, string currentBinaryPath, int currentPid,
        Func<int, RunningProcessInfo?>? probeProcess = null)
    {
        probeProcess ??= DefaultProbe;
        var path = Path.Combine(dataDir, "state.json.lock");

        // Try atomic create first.
        if (TryAtomicCreate(path, currentBinaryPath, currentPid))
            return new LockfileHandle(path);

        // Lockfile exists; inspect.
        var existing = TryRead(path);
        if (existing is null)
        {
            // Torn JSON or unreadable; treat as missing.
            File.Delete(path);
            if (!TryAtomicCreate(path, currentBinaryPath, currentPid))
                throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
                    "PRism is already running.");
            return new LockfileHandle(path);
        }

        if (IsAlive(existing.Pid, existing.BinaryPath, probeProcess))
            throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
                $"PRism is already running (PID {existing.Pid}). Use that instance, or stop it first.");

        // Stale lockfile (dead PID, or PID recycled to a different process). Take over.
        File.Delete(path);
        if (!TryAtomicCreate(path, currentBinaryPath, currentPid))
            throw new LockfileException(LockfileFailure.AnotherInstanceRunning, "PRism is already running.");
        return new LockfileHandle(path);
    }

    private static bool TryAtomicCreate(string path, string binaryPath, int pid)
    {
        try
        {
            using var fs = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None);
            var record = new LockfileRecord(pid, binaryPath, DateTime.UtcNow);
            using var writer = new StreamWriter(fs);
            writer.Write(JsonSerializer.Serialize(record, JsonSerializerOptionsFactory.Storage));
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static LockfileRecord? TryRead(string path)
    {
        try
        {
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<LockfileRecord>(json, JsonSerializerOptionsFactory.Storage);
        }
        catch (IOException) { return null; }
        catch (JsonException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
    }

    // Decides whether the process recorded in the lockfile is still a live PRism.
    // We must inspect the ACTUAL process at the PID, not lockfile-vs-current metadata:
    // when the same binary is relaunched those two are always equal, so the old check
    // treated any process that recycled the dead PID (e.g. an MSBuild dotnet node) as a
    // live PRism — a false "already running" startup crash (#107).
    private static bool IsAlive(int pid, string lockedBinaryPath, Func<int, RunningProcessInfo?> probe)
    {
        var info = probe(pid);
        if (info is null)
            return false; // No live process owns this PID — stale lock, take over.

        if (info.ExecutablePath is null)
            // Alive but its identity is unreadable (access denied / unsupported). Be
            // conservative and treat it as a live PRism: this matches the pre-fix
            // behavior for a live same-PID process, so it opens no new double-run
            // window. The single-instance guard is UX/safety, and two backends writing
            // state.json is the exact thing it exists to prevent — never trade that for
            // a process we cannot even attribute. (#107 ambiguous-case policy.)
            return true;

        // Identity is readable: it's the locked PRism only if the real executable path
        // matches the one recorded in the lockfile. A different path means the PID was
        // recycled to an unrelated process — stale, take over.
        return string.Equals(info.ExecutablePath, lockedBinaryPath, StringComparison.OrdinalIgnoreCase);
    }

    // Real-process probe used in production. Mirrors ParentLivenessProbe's catch set so
    // an unreadable process never escapes as an exception out of Acquire (which would
    // reintroduce the "backend exited before reporting a port" startup crash).
    private static RunningProcessInfo? DefaultProbe(int pid)
    {
        Process process;
        try
        {
            process = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null; // No such process — dead/expired PID.
        }

        using (process)
        {
            try
            {
                // An exited process is dead, not "unreadable" — take over rather than
                // refuse, so a recycled PID whose process dies mid-probe can't re-trigger
                // the false "already running" crash (#107).
                if (process.HasExited)
                    return null;
                return new RunningProcessInfo(process.MainModule?.FileName);
            }
            catch (Win32Exception) { return new RunningProcessInfo(null); }        // access denied / restricted (other-user, elevated, cross-bitness) — alive but unreadable
            catch (InvalidOperationException) { return null; }                     // process exited between lookup and read — dead, take over
            catch (NotSupportedException) { return new RunningProcessInfo(null); } // module info unavailable on this platform/process — alive but unreadable
        }
    }
}
