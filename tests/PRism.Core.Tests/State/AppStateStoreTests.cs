using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using FluentAssertions;
using Xunit;

namespace PRism.Core.Tests.State;

public class AppStateStoreTests
{
    [Fact]
    public async Task LoadAsync_creates_default_state_when_file_missing()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(7);
        state.Reviews.Sessions.Should().BeEmpty();
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
    public async Task LoadAsync_quarantines_malformed_json_and_creates_fresh()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, "{ this is not valid json");

        using var store = new AppStateStore(dir.Path);
        var state = await store.LoadAsync(CancellationToken.None);

        state.Version.Should().Be(7);
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().HaveCount(1);
    }

    [Fact]
    public async Task LoadAsync_self_heals_two_corrupt_loads_in_the_same_second_without_throwing()
    {
        // Regression for #607-A: the quarantine name used 1-second wall-clock resolution
        // (yyyyMMddHHmmss). Two corrupt loads in the same second produced the SAME
        // quarantine target, so the second File.Move(overwrite:false) threw IOException —
        // which escaped the catch(JsonException) raw, leaving the corrupt file unhandled.
        // A collision-proof (Guid) name lets BOTH loads self-heal in the same instant.
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");

        await File.WriteAllTextAsync(statePath, "{ corrupt one");
        using (var store1 = new AppStateStore(dir.Path))
        {
            var first = await store1.LoadAsync(CancellationToken.None);
            first.Version.Should().Be(7);
        }

        // Corrupt it again immediately — same wall-clock second as the first heal.
        await File.WriteAllTextAsync(statePath, "{ corrupt two");
        using (var store2 = new AppStateStore(dir.Path))
        {
            var second = await store2.LoadAsync(CancellationToken.None);
            second.Version.Should().Be(7);
        }

        // Both corrupt files were quarantined under DISTINCT names (no collision throw),
        // and state.json is a fresh valid default.
        Directory.GetFiles(dir.Path, "state.json.corrupt-*").Should().HaveCount(2);
        File.Exists(statePath).Should().BeTrue();
    }

    [Fact]
    public async Task SaveAsync_writes_atomically_via_temp_rename()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);
        var updated = initial.WithDefaultLastConfiguredGithubHost("https://github.com");

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
            .Select(i => store.SaveAsync(initial.WithDefaultLastConfiguredGithubHost($"https://h{i}.test"), CancellationToken.None))
            .ToArray();

        await Task.WhenAll(tasks);

        using var roundTripStore = new AppStateStore(dir.Path);
        var roundTrip = await roundTripStore.LoadAsync(CancellationToken.None);
        roundTrip.LastConfiguredGithubHost.Should().StartWith("https://h");
    }
}
