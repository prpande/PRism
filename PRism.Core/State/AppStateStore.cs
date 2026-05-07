using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.Json;

namespace PRism.Core.State;

public sealed class AppStateStore : IAppStateStore, IDisposable
{
    private const int CurrentVersion = 2;
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public AppStateStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "state.json");
    }

    public bool IsReadOnlyMode { get; private set; }

    public void Dispose() => _gate.Dispose();

    public async Task<AppState> LoadAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            if (!File.Exists(_path))
            {
                await SaveCoreAsync(AppState.Default, ct).ConfigureAwait(false);
                return AppState.Default;
            }

            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

            try
            {
                var node = JsonNode.Parse(raw, documentOptions: new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip
                });
                if (node is null) throw new JsonException("state.json parsed to null");

                node = MigrateIfNeeded(node);   // throws UnsupportedStateVersionException(0) on missing version

                var state = node.Deserialize<AppState>(JsonSerializerOptionsFactory.Storage)
                    ?? AppState.Default;
                return state;
            }
            catch (JsonException)
            {
                // The future-version branch in MigrateIfNeeded may have stamped IsReadOnlyMode=true
                // before deserialization failed. Quarantine replaces state.json with a fresh v2
                // default, so the read-only condition no longer holds.
                IsReadOnlyMode = false;
                var quarantine = $"{_path}.corrupt-{DateTime.UtcNow:yyyyMMddHHmmss}";
                File.Move(_path, quarantine, overwrite: false);
                await SaveCoreAsync(AppState.Default, ct).ConfigureAwait(false);
                return AppState.Default;
            }
        }
        finally
        {
            _gate.Release();
        }
    }

    public async Task SaveAsync(AppState state, CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Read IsReadOnlyMode under the gate so a concurrent LoadAsync's mid-flight
            // mutation cannot be observed in a torn state.
            if (IsReadOnlyMode)
                throw new InvalidOperationException(
                    "AppStateStore is in read-only mode (state.json was written by a newer PRism version). " +
                    "Saves are blocked until the binary is upgraded.");

            await SaveCoreAsync(state, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    private async Task SaveCoreAsync(AppState state, CancellationToken ct)
    {
        var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(state, JsonSerializerOptionsFactory.Storage);
        await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
        await MoveWithRetryAsync(temp, _path, ct).ConfigureAwait(false);
    }

    // On Windows, a previous File.Move can leave a transient handle on the destination
    // (Defender real-time scanner, Search Indexer, FileSystemWatcher) that races a
    // follow-up File.Move and causes UnauthorizedAccessException or a sharing-/lock-
    // violation IOException. Retry only those two transient classes with exponential
    // backoff capped near 200ms; total budget ~1.1s across 9 retries before the
    // exception propagates on attempt 10. On final exhaustion the temp file is
    // best-effort-deleted so it does not orphan in the data directory. The Windows
    // AV/indexer race does not exist on Linux/macOS, so the first attempt typically
    // succeeds there with no measurable overhead.
    private static async Task MoveWithRetryAsync(string source, string destination, CancellationToken ct)
    {
        const int maxAttempts = 10;
        var delay = TimeSpan.FromMilliseconds(10);
        try
        {
            for (var attempt = 1; ; attempt++)
            {
                try
                {
                    File.Move(source, destination, overwrite: true);
                    return;
                }
                catch (Exception ex) when (IsTransientMoveError(ex) && attempt < maxAttempts)
                {
                    await Task.Delay(delay, ct).ConfigureAwait(false);
                    delay = TimeSpan.FromMilliseconds(Math.Min(delay.TotalMilliseconds * 2, 200));
                }
            }
        }
        finally
        {
            // On success this is a no-op (File.Move consumed the source); on exhaustion
            // or any non-retried exception, best-effort cleanup of the orphaned temp.
            try { if (File.Exists(source)) File.Delete(source); }
#pragma warning disable CA1031 // best-effort cleanup; the original move-failure exception is what matters.
            catch { }
#pragma warning restore CA1031
        }
    }

    // ERROR_SHARING_VIOLATION = 0x80070020 and ERROR_LOCK_VIOLATION = 0x80070021 are the
    // two HRESULTs that signal "another handle has the file" — exactly the AV/indexer race
    // we want to retry. UnauthorizedAccessException covers the related ACCESS_DENIED case
    // that File.Move's overwrite path raises when DELETE access on the destination is
    // briefly held. Other IOException subtypes (DirectoryNotFoundException,
    // PathTooLongException, FileNotFoundException, DriveNotFoundException) are not
    // transient and propagate immediately.
    private static bool IsTransientMoveError(Exception ex)
    {
        if (ex is UnauthorizedAccessException) return true;
        if (ex is IOException
            && ex is not DirectoryNotFoundException
            && ex is not PathTooLongException
            && ex is not FileNotFoundException
            && ex is not DriveNotFoundException)
        {
            var hr = ex.HResult & 0xFFFF;
            return hr == 0x20 || hr == 0x21;
        }
        return false;
    }

    private JsonNode MigrateIfNeeded(JsonNode root)
    {
        // JsonNode's string indexer (root["version"]) and AsObject() throw
        // InvalidOperationException for non-object nodes — that escapes the
        // catch (JsonException) in LoadAsync. Funnel non-object roots through
        // the quarantine path explicitly.
        if (root is not JsonObject)
            throw new JsonException("state.json root must be a JSON object");

        var versionNode = root["version"];
        if (versionNode is null)
            throw new UnsupportedStateVersionException(0);

        int stored;
        try
        {
            stored = versionNode.GetValue<int>();
        }
        catch (Exception ex) when (ex is InvalidOperationException or FormatException or OverflowException)
        {
            // Translate to JsonException so the existing quarantine path in LoadAsync handles
            // a malformed `version` value (e.g. "1" as a string, 1.5 as a float, or a number
            // outside int range) the same way as any other corrupt state.json.
            throw new JsonException("state.json `version` field is not an integer", ex);
        }

        if (stored > CurrentVersion)
        {
            IsReadOnlyMode = true;
            return root;     // load best-effort; SaveAsync will refuse
        }

        // Only versions in [1, CurrentVersion] are recognized. Version 0 / negative
        // were never real formats; quarantine instead of silently migrating them.
        if (stored < 1)
            throw new JsonException($"state.json has unsupported version {stored}");

        if (stored == 1) root = MigrateV1ToV2(root);
        EnsureV2Shape(root);
        IsReadOnlyMode = false;
        return root;
    }

    private static JsonNode MigrateV1ToV2(JsonNode root)
    {
        var sessionsNode = root["review-sessions"];
        if (sessionsNode is not null)
        {
            // AsObject() throws InvalidOperationException for non-object nodes —
            // funnel through JsonException so LoadAsync's catch quarantines instead.
            if (sessionsNode is not JsonObject sessions)
                throw new JsonException("state.json 'review-sessions' must be a JSON object");

            foreach (var sessionEntry in sessions)
            {
                if (sessionEntry.Value is JsonObject obj && obj["viewed-files"] is null)
                    obj["viewed-files"] = new JsonObject();
            }
        }
        root["version"] = 2;
        return root;
    }

    // Forward-fixup for v2 top-level fields added after the initial v2 cut shipped.
    // PR #14's v2 wrote files lacking `ui-preferences`; this step runs on every v2 read
    // (regardless of `stored` version) and backfills the defaulted shape. The next
    // SaveAsync persists the result. Idempotent — repeated runs are no-ops. Spec § 6.3.
    private static void EnsureV2Shape(JsonNode root)
    {
        if (root["ui-preferences"] is null)
            root["ui-preferences"] = new JsonObject { ["diff-mode"] = "side-by-side" };
    }
}
