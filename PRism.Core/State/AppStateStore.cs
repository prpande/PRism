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
        if (IsReadOnlyMode)
            throw new InvalidOperationException(
                "AppStateStore is in read-only mode (state.json was written by a newer PRism version). " +
                "Saves are blocked until the binary is upgraded.");

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
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
        File.Move(temp, _path, overwrite: true);
    }

    private JsonNode? MigrateIfNeeded(JsonNode root)
    {
        var versionNode = root["version"];
        if (versionNode is null)
            throw new UnsupportedStateVersionException(0);

        var stored = versionNode.GetValue<int>();

        if (stored > CurrentVersion)
        {
            IsReadOnlyMode = true;
            return root;     // load best-effort; SaveAsync will refuse
        }

        if (stored < 2) root = MigrateV1ToV2(root);
        IsReadOnlyMode = false;
        return root;
    }

    private static JsonNode MigrateV1ToV2(JsonNode root)
    {
        var sessions = root["review-sessions"]?.AsObject();
        if (sessions is not null)
        {
            foreach (var sessionEntry in sessions)
            {
                if (sessionEntry.Value is JsonObject obj && obj["viewed-files"] is null)
                    obj["viewed-files"] = new JsonObject();
            }
        }
        root["version"] = 2;
        return root;
    }
}
