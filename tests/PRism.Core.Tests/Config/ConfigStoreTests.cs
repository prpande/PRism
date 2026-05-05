using PRism.Core.Config;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.Config;

public class ConfigStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_defaults_when_file_missing()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        store.Current.Ui.Accent.Should().Be("indigo");
        store.Current.Ui.AiPreview.Should().BeFalse();
        store.Current.Github.Host.Should().Be("https://github.com");
        File.Exists(Path.Combine(dir.Path, "config.json")).Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_with_malformed_json_falls_back_to_defaults_without_overwrite()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        var bad = "{ broken";
        await File.WriteAllTextAsync(path, bad);

        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("system");
        (await File.ReadAllTextAsync(path)).Should().Be(bad);            // file preserved
        store.LastLoadError.Should().NotBeNull();
    }

    [Fact]
    public async Task PatchAsync_with_single_field_succeeds_and_persists()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        await store.PatchAsync(new Dictionary<string, object?> { ["theme"] = "dark" }, CancellationToken.None);

        store.Current.Ui.Theme.Should().Be("dark");
        using var roundTrip = new ConfigStore(dir.Path);
        await roundTrip.InitAsync(CancellationToken.None);
        roundTrip.Current.Ui.Theme.Should().Be("dark");
    }

    [Fact]
    public async Task PatchAsync_with_multi_field_throws()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["theme"] = "dark", ["accent"] = "amber" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("exactly one"));
    }

    [Fact]
    public async Task PatchAsync_with_unknown_field_throws()
    {
        using var dir = new TempDataDir();
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        Func<Task> act = () => store.PatchAsync(
            new Dictionary<string, object?> { ["unknown"] = "x" },
            CancellationToken.None);

        await act.Should().ThrowAsync<ConfigPatchException>()
            .Where(e => e.Message.Contains("unknown"));
    }

    [Fact]
    public async Task External_edit_triggers_reload_within_polling_window()
    {
        using var dir = new TempDataDir();
        var path = Path.Combine(dir.Path, "config.json");
        using var store = new ConfigStore(dir.Path);
        await store.InitAsync(CancellationToken.None);

        var original = await File.ReadAllTextAsync(path);
        var modified = original.Replace("\"theme\":\"system\"", "\"theme\":\"dark\"", StringComparison.Ordinal);
        await File.WriteAllTextAsync(path, modified);

        // FileSystemWatcher debounce + reload happens; allow up to 2s
        for (var i = 0; i < 20 && store.Current.Ui.Theme != "dark"; i++)
            await Task.Delay(100);

        store.Current.Ui.Theme.Should().Be("dark");
    }
}
