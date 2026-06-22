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
    public static IReadOnlyDictionary<string, string> RebuildEnv(ClaudeCliStateRecord record)
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
