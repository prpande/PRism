using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.State;

public sealed class AppStateStore : IAppStateStore, IDisposable
{
    private const int CurrentVersion = 1;
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);

    public AppStateStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "state.json");
    }

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
                using var doc = JsonDocument.Parse(raw, new JsonDocumentOptions
                {
                    AllowTrailingCommas = true,
                    CommentHandling = JsonCommentHandling.Skip
                });
                if (!doc.RootElement.TryGetProperty("version", out var versionElement))
                    throw new UnsupportedStateVersionException(0);

                var version = versionElement.GetInt32();
                if (version != CurrentVersion)
                    throw new UnsupportedStateVersionException(version);

                var state = JsonSerializer.Deserialize<AppState>(raw, JsonSerializerOptionsFactory.Storage)
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
}
