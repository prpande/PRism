using System.Text.Json;
using System.Text.Json.Nodes;
using PRism.Core.Json;
using PRism.Core.State.Migrations;
using PRism.Core.Storage;

namespace PRism.Core.State;

public sealed class AppStateStore : IAppStateStore, IDisposable
{
    private const int CurrentVersion = 7;

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
            (6, AppStateMigrations.MigrateV5ToV6),  // cross-tab-stamp slice — per-tab TabStamps map replaces session-flat last-viewed-head-sha
            (7, AppStateMigrations.MigrateV6ToV7),  // PR-root Post + submit-discard slice — lifts DraftSummaryMarkdown into a PR-root DraftComment row
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
            // before deserialization failed. Quarantine replaces state.json with a fresh
            // default, so the read-only condition no longer holds.
            IsReadOnlyMode = false;
            await QuarantineAndResetAsync(ct).ConfigureAwait(false);
            return AppState.Default;
        }
    }

    // Self-heal a corrupt state.json. Move the bad file aside under a collision-proof name,
    // then write a fresh default. Both steps are best-effort: NEITHER a quarantine-name
    // collision (two corrupt loads in the same instant) NOR a failed resave (disk full,
    // permissions) may escape LoadAsync as an unhandled exception — that would leave the
    // corrupt file in place AND propagate a raw IOException past the catch(JsonException)
    // that is supposed to make corruption recoverable.
    private async Task QuarantineAndResetAsync(CancellationToken ct)
    {
        // Collision-proof name: a Guid (plus a millisecond-resolution timestamp for human
        // readability) — NOT the old 1-second `yyyyMMddHHmmss`. Two corrupt loads in the
        // same wall-clock second previously produced the SAME name, so the second
        // File.Move(overwrite:false) threw IOException (destination exists) and escaped the
        // catch(JsonException) raw — the corrupt file was never quarantined or replaced.
        var quarantine = $"{_path}.corrupt-{DateTime.UtcNow:yyyyMMddHHmmssfff}-{Guid.NewGuid():N}";
        try
        {
            File.Move(_path, quarantine, overwrite: false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The move-aside failed (residual name collision, a lock on the file, or
            // permissions). Fall back to deleting the corrupt file so its stale content is
            // gone even if the resave below also fails. If the delete fails too, swallow it:
            // SaveCoreAsync's atomic rename overwrites _path anyway, and we must not crash
            // the load over an un-quarantinable corrupt file.
            try
            {
                File.Delete(_path);
            }
            catch (Exception delEx) when (delEx is IOException or UnauthorizedAccessException)
            {
                // Can't move OR delete. Degrade gracefully — the resave attempt overwrites.
            }
        }

        try
        {
            await SaveCoreAsync(AppState.Default, ct).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            // The resave failed (disk full, permissions). Self-heal still degrades
            // gracefully: the corrupt file is already quarantined/deleted, and the caller
            // returns the in-memory AppState.Default so the app starts. A later successful
            // SaveAsync persists the default. (OperationCanceledException is intentionally
            // NOT swallowed — a cancelled load should propagate cancellation.)
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
        if (accountsObj[AccountKeys.Default] is not JsonObject defaultObj)
        {
            defaultObj = new JsonObject();
            accountsObj[AccountKeys.Default] = defaultObj;
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

        // V5→V6 backfill: every session under every account gets a tab-stamps map. A
        // future-version file might list sessions without the new field; without this
        // backfill the deserializer would NRE on session.TabStamps. Iterates EVERY
        // account (not just accounts.default) for the same reason MigrateV5ToV6 does:
        // multi-account state is the V5 shape we live in now.
        foreach (var (_, accountNode) in accountsObj)
        {
            var sessionsObj = (accountNode as JsonObject)?["reviews"]?["sessions"] as JsonObject;
            if (sessionsObj is null) continue;
            foreach (var (_, sessionNode) in sessionsObj)
            {
                if (sessionNode is JsonObject session && session["tab-stamps"] is null)
                    session["tab-stamps"] = new JsonObject();
            }
        }
    }
}
