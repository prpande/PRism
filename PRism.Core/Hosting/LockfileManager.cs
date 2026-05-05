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

public static class LockfileManager
{
    public static LockfileHandle Acquire(string dataDir, string currentBinaryPath, int currentPid)
    {
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

        if (IsAlive(existing.Pid, existing.BinaryPath, currentBinaryPath))
            throw new LockfileException(LockfileFailure.AnotherInstanceRunning,
                $"PRism is already running (PID {existing.Pid}). Use that instance, or stop it first.");

        // Stale lockfile (dead PID, recycled PID, or different binary). Take over.
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

    private static bool IsAlive(int pid, string lockedBinaryPath, string currentBinaryPath)
    {
        try
        {
            using var p = Process.GetProcessById(pid);
            // Process exists; require matching binary path to claim "another live PRism".
            // If the binary differs, the PID was recycled — treat as stale.
            return string.Equals(lockedBinaryPath, currentBinaryPath, StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
        catch (InvalidOperationException)
        {
            return false;
        }
    }
}
