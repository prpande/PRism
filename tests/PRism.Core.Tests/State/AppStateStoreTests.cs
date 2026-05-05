using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_default_v1_state_when_file_missing()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(1);
        state.ReviewSessions.Should().BeEmpty();
        state.LastConfiguredGithubHost.Should().BeNull();
        File.Exists(Path.Combine(dir.Path, "state.json")).Should().BeTrue();
    }

    [Fact]
    public async Task LoadAsync_reads_existing_v1_file()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"),
            "{\"version\":1,\"review-sessions\":{},\"ai-state\":{\"repo-clone-map\":{},\"workspace-mtime-at-last-enumeration\":null},\"last-configured-github-host\":\"https://github.com\"}");

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);
        state.LastConfiguredGithubHost.Should().Be("https://github.com");
    }

    [Fact]
    public async Task LoadAsync_refuses_unknown_version()
    {
        using var dir = new TempDataDir();
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), "{\"version\":2}");

        using var store = new AppStateStore(dir.Path);
        await FluentActions.Invoking(() => store.LoadAsync(CancellationToken.None))
            .Should().ThrowAsync<UnsupportedStateVersionException>()
            .Where(e => e.Version == 2);
    }

    [Fact]
    public async Task LoadAsync_quarantines_malformed_json_and_creates_fresh()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, "{ this is not valid json");

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(1);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().HaveCount(1);
    }

    [Fact]
    public async Task SaveAsync_writes_atomically_via_temp_rename()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);
        var updated = initial with { LastConfiguredGithubHost = "https://github.com" };

        await store.SaveAsync(updated, CancellationToken.None);

        using var roundTripStore = new AppStateStore(dir.Path);
        var roundTrip = await roundTripStore.LoadAsync(CancellationToken.None);
        roundTrip.LastConfiguredGithubHost.Should().Be("https://github.com");
    }

    [Fact]
    public async Task SaveAsync_serializes_concurrent_writes()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);

        var tasks = Enumerable.Range(0, 50)
            .Select(i => store.SaveAsync(initial with { LastConfiguredGithubHost = $"https://h{i}.test" }, CancellationToken.None))
            .ToArray();

        await Task.WhenAll(tasks);

        using var roundTripStore = new AppStateStore(dir.Path);
        var roundTrip = await roundTripStore.LoadAsync(CancellationToken.None);
        roundTrip.LastConfiguredGithubHost.Should().StartWith("https://h");
    }
}
