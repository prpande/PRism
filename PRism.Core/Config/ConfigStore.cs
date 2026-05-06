using System.Text.Json;
using PRism.Core.Json;

namespace PRism.Core.Config;

public sealed class ConfigStore : IConfigStore, IDisposable
{
    private readonly string _path;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private FileSystemWatcher? _watcher;
    private AppConfig _current = AppConfig.Default;
    private static readonly HashSet<string> _allowedUiFields = new(StringComparer.Ordinal) { "theme", "accent", "aiPreview" };

    public ConfigStore(string dataDir)
    {
        _path = Path.Combine(dataDir, "config.json");
    }

    public AppConfig Current => _current;
    public Exception? LastLoadError { get; private set; }
    public event EventHandler<ConfigChangedEventArgs>? Changed;

    private void RaiseChanged() => Changed?.Invoke(this, new ConfigChangedEventArgs(_current));

    public async Task InitAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            await ReadFromDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        TryStartWatcher();
    }

    public async Task PatchAsync(IReadOnlyDictionary<string, object?> patch, CancellationToken ct)
    {
        ArgumentNullException.ThrowIfNull(patch);
        if (patch.Count != 1)
            throw new ConfigPatchException("patch must contain exactly one field");
        var (key, value) = patch.Single();
        if (!_allowedUiFields.Contains(key))
            throw new ConfigPatchException($"unknown field: {key}");

        await _gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            var ui = _current.Ui;
            var newUi = key switch
            {
                "theme" => ui with { Theme = (string)value! },
                "accent" => ui with { Accent = (string)value! },
                "aiPreview" => ui with { AiPreview = Convert.ToBoolean(value, System.Globalization.CultureInfo.InvariantCulture) },
                _ => throw new ConfigPatchException($"unknown field: {key}")
            };
            _current = _current with { Ui = newUi };
            await WriteToDiskAsync(ct).ConfigureAwait(false);
        }
        finally
        {
            _gate.Release();
        }
        RaiseChanged();
    }

    private async Task ReadFromDiskAsync(CancellationToken ct)
    {
        if (!File.Exists(_path))
        {
            _current = AppConfig.Default;
            await WriteToDiskAsync(ct).ConfigureAwait(false);
            LastLoadError = null;
            return;
        }
        try
        {
            string raw;
            using (var fs = new FileStream(_path, FileMode.Open, FileAccess.Read, FileShare.Read))
            using (var reader = new StreamReader(fs))
                raw = await reader.ReadToEndAsync(ct).ConfigureAwait(false);

            var parsed = JsonSerializer.Deserialize<AppConfig>(raw, JsonSerializerOptionsFactory.Storage);
            if (parsed is null)
            {
                _current = AppConfig.Default;
                LastLoadError = null;
                return;
            }

            // Backfill any sub-record that's null on disk. Older config.json files (or
            // partial configs in tests) can lack entire top-level sections; without these
            // guards, a positional record's missing constructor argument deserializes to
            // null and DI factories that read e.g. config.Current.Ui.AiPreview throw.
            // The Inbox guard has an extra level: legacy S0+S1 files have the inbox key but
            // lack inbox.sections / inbox.deduplicate, so Sections can be null even when
            // Inbox itself is present — in that case preserve ShowHiddenScopeFooter.
            parsed = parsed with
            {
                Polling    = parsed.Polling    ?? AppConfig.Default.Polling,
                Inbox      = parsed.Inbox is null
                                ? AppConfig.Default.Inbox
                                : parsed.Inbox.Sections is null
                                    ? AppConfig.Default.Inbox with { ShowHiddenScopeFooter = parsed.Inbox.ShowHiddenScopeFooter }
                                    : parsed.Inbox,
                Review     = parsed.Review     ?? AppConfig.Default.Review,
                Iterations = parsed.Iterations ?? AppConfig.Default.Iterations,
                Logging    = parsed.Logging    ?? AppConfig.Default.Logging,
                Ui         = parsed.Ui         ?? AppConfig.Default.Ui,
                Github     = parsed.Github     ?? AppConfig.Default.Github,
                Llm        = parsed.Llm        ?? AppConfig.Default.Llm,
            };
            _current = parsed;
            LastLoadError = null;
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
        {
            LastLoadError = ex;
            _current = AppConfig.Default;
            // do NOT overwrite the broken file
        }
    }

    private async Task WriteToDiskAsync(CancellationToken ct)
    {
        var temp = $"{_path}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(_current, JsonSerializerOptionsFactory.Storage);
        await File.WriteAllTextAsync(temp, json, ct).ConfigureAwait(false);
        File.Move(temp, _path, overwrite: true);
    }

    private void TryStartWatcher()
    {
        try
        {
            var dir = Path.GetDirectoryName(_path)!;
            _watcher = new FileSystemWatcher(dir, "config.json")
            {
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size,
                EnableRaisingEvents = true
            };
            _watcher.Changed += OnFileChanged;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
        {
            // FSW failed to register; degrade silently — mtime-poll fallback intentionally out of S0+S1.
            LastLoadError = ex;
        }
    }

    private void OnFileChanged(object sender, FileSystemEventArgs e)
    {
        // Fire-and-forget reload; exceptions are swallowed inside HandleFileChangedAsync.
        _ = HandleFileChangedAsync();
    }

    private async Task HandleFileChangedAsync()
    {
        try
        {
            await Task.Delay(100).ConfigureAwait(false); // debounce save flurry
            await _gate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            try
            {
                await ReadFromDiskAsync(CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                _gate.Release();
            }
            RaiseChanged();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ObjectDisposedException)
        {
            LastLoadError = ex;
        }
    }

    public void Dispose()
    {
        if (_watcher is not null)
        {
            _watcher.Changed -= OnFileChanged;
            _watcher.Dispose();
        }
        _gate.Dispose();
    }
}
