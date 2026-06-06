using System.Text.Json;
using PRism.AI.Contracts.Provider;

namespace PRism.AI.ClaudeCode;

/// <summary>
/// Append-only JSONL usage log under a per-user directory. The record type's shape IS the
/// field-filter: it has no env/secret field, so structured logging cannot leak one. On POSIX the
/// directory is restricted to owner rwx (700) via <see cref="File.SetUnixFileMode"/>; on Windows
/// the per-user dataDir is owner-restricted by OS default, so no ACL code is needed (and none runs).
/// </summary>
public sealed class JsonlTokenUsageTracker : ITokenUsageTracker, IDisposable
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public JsonlTokenUsageTracker(string usageDir)
    {
        ArgumentException.ThrowIfNullOrEmpty(usageDir);
        Directory.CreateDirectory(usageDir);
        if (!OperatingSystem.IsWindows())
        {
            // POSIX: owner-only (rwx------). Windows needs no equivalent here — the per-user dataDir
            // is already owner-restricted by the OS default ACL.
            File.SetUnixFileMode(usageDir,
                UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        _path = Path.Combine(usageDir, "token-usage.jsonl");
    }

    public async Task RecordAsync(TokenUsageRecord record, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(record);
        var stamped = record.RecordedAt == default ? record with { RecordedAt = DateTimeOffset.UtcNow } : record;
        var line = JsonSerializer.Serialize(stamped, Options);
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await File.AppendAllTextAsync(_path, line + Environment.NewLine, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();
}
