using FluentAssertions;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.State;

// #664 — AppStateStore keeps an in-memory copy of the parsed AppState (like ConfigStore's
// _current) so the steady-state LoadAsync is a field access, not a full
// read→parse→migrate→deserialize. These tests pin the cache semantics: it serves from
// memory on the hit path, stays coherent across every write, and invalidates on reset.
//
// The cache's correctness rests on the single-writer invariant (AppStateStore is the sole
// writer of its state.json under _gate, enforced cross-process by LockfileManager and
// in-process by singleton registration). Several tests below deliberately write state.json
// OUT-OF-BAND — something production never does — purely to prove the steady-state path
// serves the cache rather than re-reading disk.
public class AppStateStoreCacheTests
{
    private static string StateJsonWithHost(string host) => $$"""
    {
      "version": 7,
      "ui-preferences": { "diff-mode": "side-by-side" },
      "accounts": {
        "default": {
          "reviews": { "sessions": {} },
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "{{host}}"
        }
      }
    }
    """;

    [Fact]
    public async Task LoadAsync_serves_cached_state_and_does_not_reread_disk_after_first_load()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://first.test"));

        using var store = new AppStateStore(dir.Path);
        var first = await store.LoadAsync(CancellationToken.None);
        first.LastConfiguredGithubHost.Should().Be("https://first.test");

        // Mutate state.json out-of-band. A store that re-reads on every load would observe
        // this; a store serving the cache returns the value parsed at first load.
        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://second.test"));

        var second = await store.LoadAsync(CancellationToken.None);
        second.LastConfiguredGithubHost.Should().Be("https://first.test",
            because: "the steady-state LoadAsync must serve the in-memory cache, not re-read state.json");
    }

    [Fact]
    public async Task UpdateAsync_does_not_reparse_disk_on_a_second_call()
    {
        // The issue's named acceptance test: two sequential UpdateAsync calls must re-parse
        // state.json once (the first load), not per-call. Out-of-band-mutate the file between the
        // two updates and prove the second transform receives the CACHED prior state, not the disk
        // value — a store that re-read on each UpdateAsync would hand the transform "oob".
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://first.test"));

        using var store = new AppStateStore(dir.Path);

        string? firstSeen = null;
        await store.UpdateAsync(s => { firstSeen = s.LastConfiguredGithubHost; return s.WithDefaultLastConfiguredGithubHost("https://after-first.test"); }, CancellationToken.None);
        firstSeen.Should().Be("https://first.test", because: "the first UpdateAsync is a cache miss that reads disk");

        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://oob.test"));

        string? secondSeen = null;
        await store.UpdateAsync(s => { secondSeen = s.LastConfiguredGithubHost; return s; }, CancellationToken.None);
        secondSeen.Should().Be("https://after-first.test",
            because: "the second UpdateAsync must observe the cached prior write, not re-parse the out-of-band disk edit");
    }

    [Fact]
    public async Task LoadAsync_after_UpdateAsync_returns_the_updated_state_from_cache()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);

        await store.UpdateAsync(s => s.WithDefaultLastConfiguredGithubHost("https://updated.test"), CancellationToken.None);

        var loaded = await store.LoadAsync(CancellationToken.None);
        loaded.LastConfiguredGithubHost.Should().Be("https://updated.test",
            because: "UpdateAsync keeps the cache coherent; a following LoadAsync sees the write");
    }

    [Fact]
    public async Task SaveAsync_updates_the_cache()
    {
        using var dir = new TempDataDir();
        using var store = new AppStateStore(dir.Path);
        var initial = await store.LoadAsync(CancellationToken.None);

        await store.SaveAsync(initial.WithDefaultLastConfiguredGithubHost("https://saved.test"), CancellationToken.None);

        var loaded = await store.LoadAsync(CancellationToken.None);
        loaded.LastConfiguredGithubHost.Should().Be("https://saved.test",
            because: "SaveAsync updates _current so a following LoadAsync serves the saved value from cache");
    }

    [Fact]
    public async Task ResetToDefaultAsync_invalidates_the_cache()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://first.test"));

        using var store = new AppStateStore(dir.Path);
        var first = await store.LoadAsync(CancellationToken.None);
        first.LastConfiguredGithubHost.Should().Be("https://first.test");

        await store.ResetToDefaultAsync(CancellationToken.None);

        // The file is gone and the cache is invalidated: an in-process LoadAsync must re-seed
        // AppState.Default, not serve the pre-reset cached state.
        var afterReset = await store.LoadAsync(CancellationToken.None);
        afterReset.LastConfiguredGithubHost.Should().BeNull(because: "ResetToDefaultAsync nulls _current");
        afterReset.Version.Should().Be(7);
    }

    [Fact]
    public async Task ReadOnly_future_version_state_is_cached_and_stays_read_only()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        // version > CurrentVersion → read-only best-effort load (no persist).
        await File.WriteAllTextAsync(statePath, """
        {
          "version": 99,
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://future.test"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        _ = await store.LoadAsync(CancellationToken.None);
        store.IsReadOnlyMode.Should().BeTrue();

        // Out-of-band replace with a valid current-version file; the cache must still serve the
        // read-only state from first load (no re-detect, no re-read).
        await File.WriteAllTextAsync(statePath, StateJsonWithHost("https://now-valid.test"));

        _ = await store.LoadAsync(CancellationToken.None);
        store.IsReadOnlyMode.Should().BeTrue(because: "the read-only state is cached; later loads do not re-detect");

        var save = async () => await store.SaveAsync(AppState.Default, CancellationToken.None);
        await save.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");
    }

    [Fact]
    public async Task CorruptState_quarantines_caches_default_and_allows_saves()
    {
        using var dir = new TempDataDir();
        var statePath = Path.Combine(dir.Path, "state.json");
        await File.WriteAllTextAsync(statePath, "{ not valid json");

        using var store = new AppStateStore(dir.Path);
        var loaded = await store.LoadAsync(CancellationToken.None);
        loaded.Version.Should().Be(7);
        store.IsReadOnlyMode.Should().BeFalse(because: "the corrupt/quarantine path clears read-only");

        // Read-only was cleared, so a save succeeds and persists.
        await store.SaveAsync(loaded.WithDefaultLastConfiguredGithubHost("https://post-quarantine.test"), CancellationToken.None);

        using var roundTrip = new AppStateStore(dir.Path);
        var reloaded = await roundTrip.LoadAsync(CancellationToken.None);
        reloaded.LastConfiguredGithubHost.Should().Be("https://post-quarantine.test");
    }

    [Fact]
    public async Task Cross_instance_round_trip_still_reads_the_persisted_value()
    {
        // Regression guard: the per-instance cache must not break the writeStore/readStore pattern.
        // Instance B's first load is a cache miss that reads what instance A persisted.
        using var dir = new TempDataDir();
        using (var a = new AppStateStore(dir.Path))
            await a.UpdateAsync(s => s.WithDefaultLastConfiguredGithubHost("https://from-a.test"), CancellationToken.None);

        using var b = new AppStateStore(dir.Path);
        var loaded = await b.LoadAsync(CancellationToken.None);
        loaded.LastConfiguredGithubHost.Should().Be("https://from-a.test");
    }
}
