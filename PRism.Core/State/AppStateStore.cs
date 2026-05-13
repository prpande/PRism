using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.Json;
using PRism.Core.State.Migrations;
using PRism.Core.Storage;

namespace PRism.Core.State;

public sealed class AppStateStore : IAppStateStore, IDisposable
{
    private const int CurrentVersion = 5;

    // Per-step migrations applied in ascending ToVersion order. Each step takes a JsonObject
    // at version N-1 and returns the same root mutated to version N. Adding a step here is
    // the single place that introduces a new schema version — bumping CurrentVersion alone
    // is not enough.
    // Steps MUST be defined in ascending ToVersion order. AppStateMigrationsOrderingTests
    // pins this, and the runtime guard below sorts defensively in case an out-of-order
    // entry slips past code review — a v2 file running v3→v4 before v2→v3 would silently
    // corrupt state. Sort cost is one-time at type init; the array is tiny.
    private static readonly (int ToVersion, Func<JsonObject, JsonObject> Transform)[] MigrationSteps =
        new (int ToVersion, Func<JsonObject, JsonObject> Transform)[]
        {
            (2, AppStateMigrations.MigrateV1ToV2),
            (3, AppStateMigrations.MigrateV2ToV3),
            (4, AppStateMigrations.MigrateV3ToV4),  // S5 PR2 — adds DraftComment.ThreadId
            (5, AppStateMigrations.MigrateV4ToV5),  // S6 PR0 — moves reviews/ai-state/last-host under accounts.default
        }.OrderBy(s => s.ToVersion).ToArray();
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
            return await LoadCoreAsync(ct).ConfigureAwait(false);
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

    public async Task UpdateAsync(Func<AppState, AppState> transform, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(transform);

        // Hold the gate across load → transform → save so concurrent callers each observe
        // prior callers' persisted writes (P1.3: two-tab mark-viewed safety).
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var current = await LoadCoreAsync(ct).ConfigureAwait(false);

            // Read-only check happens AFTER the load so future-version state.json detection
            // (which sets IsReadOnlyMode inside MigrateIfNeeded) takes effect on this call.
            if (IsReadOnlyMode)
                throw new InvalidOperationException(
                    "AppStateStore is in read-only mode (state.json was written by a newer PRism version). " +
                    "Saves are blocked until the binary is upgraded.");

            var updated = transform(current);
            await SaveCoreAsync(updated, ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
    }

    // Inner load body without gate acquisition; callers must already hold _gate. Shared
    // between LoadAsync (public, takes the gate) and UpdateAsync (already inside the gate).
    private async Task<AppState> LoadCoreAsync(CancellationToken ct)
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

    public async Task ResetToDefaultAsync(CancellationToken ct)
    {
        // Setup-bypass: this path intentionally does NOT honor IsReadOnlyMode — the
        // whole point is to recover from a future-version state.json that put the
        // store into read-only mode in the first place. Caller is responsible for
        // triggering a process restart so the next launch loads AppState.Default.
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            try
            {
                if (File.Exists(_path)) File.Delete(_path);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                // P2.20: surface a domain exception so Setup can render recovery copy
                // ("close PRism in any other window and retry") instead of crashing
                // the request with a raw IOException.
                throw new StateResetFailedException(
                    "Failed to delete state.json. Another process may have it open. Close PRism and retry.",
                    ex);
            }
            IsReadOnlyMode = false;
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
        await AtomicFileMove.MoveAsync(temp, _path, ct).ConfigureAwait(false);
    }

    private JsonObject MigrateIfNeeded(JsonNode root)
    {
        // JsonNode's string indexer (root["version"]) and AsObject() throw
        // InvalidOperationException for non-object nodes — that escapes the
        // catch (JsonException) in LoadAsync. Funnel non-object roots through
        // the quarantine path explicitly.
        if (root is not JsonObject obj)
            throw new JsonException("state.json root must be a JSON object");

        var versionNode = obj["version"];
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
            // Best-effort load: still backfill known current-shape defaults so the deserializer
            // doesn't trip on optional fields a future-version file might also lack. Without
            // this, a missing optional field cascades into the JsonException quarantine path,
            // which would clear IsReadOnlyMode and delete the file — defeating the read-only intent.
            EnsureCurrentShape(obj);
            return obj;
        }

        // Only versions in [1, CurrentVersion] are recognized. Version 0 / negative
        // were never real formats; quarantine instead of silently migrating them.
        if (stored < 1)
            throw new JsonException($"state.json has unsupported version {stored}");

        // Apply each migration step whose ToVersion is greater than the stored version,
        // in ascending order. A v1 file runs both v1→v2 and v2→v3; a v2 file runs only v2→v3.
        foreach (var (toVersion, transform) in MigrationSteps)
        {
            if (toVersion > stored && toVersion <= CurrentVersion)
                obj = transform(obj);
        }

        EnsureCurrentShape(obj);
        IsReadOnlyMode = false;
        return obj;
    }

    // Forward-fixup for current-shape top-level fields added after a version cut shipped.
    // Runs on every read that reaches the deserializer (migration path, plain current-version
    // path, and the future-version best-effort path) and backfills the defaulted shape. The
    // next SaveAsync persists the result on the migration/current paths; the future-version
    // path stays read-only and only uses the in-memory backfill to keep deserialization from
    // tripping on optional missing fields. Idempotent — repeated runs are no-ops. Spec § 6.3.
    private static void EnsureCurrentShape(JsonObject root)
    {
        if (root["ui-preferences"] is null)
            root["ui-preferences"] = new JsonObject { ["diff-mode"] = "side-by-side" };

        // Ensure the V5 accounts container exists with a default entry. A V5 file written by a
        // newer PRism (future-version branch) that omits an optional sub-field still needs the
        // structural backbone in place for deserialization to succeed.
        if (root["accounts"] is not JsonObject accountsObj)
        {
            accountsObj = new JsonObject();
            root["accounts"] = accountsObj;
        }
        if (accountsObj["default"] is not JsonObject defaultObj)
        {
            defaultObj = new JsonObject();
            accountsObj["default"] = defaultObj;
        }

        // Forward-fixup the reviews.sessions backbone under accounts.default (the V3-era
        // equivalent applied at the root; V5 moves it under the account).
        if (defaultObj["reviews"] is null)
        {
            defaultObj["reviews"] = new JsonObject { ["sessions"] = new JsonObject() };
        }
        else if (defaultObj["reviews"] is JsonObject reviewsObj && reviewsObj["sessions"] is null)
        {
            // Defense against partial wraps like `"reviews": {}` — without this, the
            // deserializer produces `Reviews.Sessions == null` and the next
            // state.Reviews.Sessions.TryGetValue(...) NREs at the consumer site.
            reviewsObj["sessions"] = new JsonObject();
        }

        if (defaultObj["ai-state"] is null)
        {
            defaultObj["ai-state"] = new JsonObject
            {
                ["repo-clone-map"] = new JsonObject(),
                ["workspace-mtime-at-last-enumeration"] = null
            };
        }
    }
}
