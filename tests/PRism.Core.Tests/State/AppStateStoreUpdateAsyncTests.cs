using FluentAssertions;
using PRism.Core.State;
using PRism.Core.Tests.TestHelpers;
using Xunit;

namespace PRism.Core.Tests.State;

// P1.3 — `mark-viewed` and `files/viewed` endpoints in PR4 mutate ReviewSessionState
// concurrently from two browser tabs. They must gate Load+transform+Save under one lock so
// neither tab's write stomps the other. AppStateStore already has a SemaphoreSlim _gate;
// UpdateAsync(transform, ct) is the API surface that exposes that gate to consumers.
//
// Semantics: last-transform-wins. Each transform observes the most-recently-persisted state.
// No torn reads, no lost writes.
public class AppStateStoreUpdateAsyncTests
{
    [Fact]
    public async Task UpdateAsync_invokes_transform_with_current_state_and_persists_result()
    {
        using var dir = new TempDataDir();
        IAppStateStore store = new AppStateStore(dir.Path);

        await store.UpdateAsync(state => state with { LastConfiguredGithubHost = "https://updated.test" }, CancellationToken.None);

        using var roundTrip = new AppStateStore(dir.Path);
        var loaded = await roundTrip.LoadAsync(CancellationToken.None);
        loaded.LastConfiguredGithubHost.Should().Be("https://updated.test");
    }

    [Fact]
    public async Task UpdateAsync_concurrent_transforms_each_observe_prior_writes_no_lost_writes()
    {
        // 50 concurrent UpdateAsync calls, each appending its index to a string list inside
        // ReviewSessions. If the gate is correctly held across load+transform+save, every
        // transform's append is preserved (final list has all 50 entries). A naive
        // load-then-save would lose writes when two transforms read the same baseline.
        using var dir = new TempDataDir();
        IAppStateStore store = new AppStateStore(dir.Path);

        // Seed an initial session so transforms have somewhere to accumulate.
        await store.UpdateAsync(s => s with
        {
            ReviewSessions = new Dictionary<string, ReviewSessionState>
            {
                ["o/r/1"] = new ReviewSessionState(null, null, null, null, new Dictionary<string, string>())
            }
        }, CancellationToken.None);

        var tasks = Enumerable.Range(0, 50)
            .Select(i => store.UpdateAsync(s =>
            {
                var session = s.ReviewSessions["o/r/1"];
                var viewedFiles = session.ViewedFiles.ToDictionary(kv => kv.Key, kv => kv.Value);
                viewedFiles[$"file-{i}.cs"] = "head1";
                var sessions = s.ReviewSessions.ToDictionary(kv => kv.Key, kv => kv.Value);
                sessions["o/r/1"] = session with { ViewedFiles = viewedFiles };
                return s with { ReviewSessions = sessions };
            }, CancellationToken.None))
            .ToArray();

        await Task.WhenAll(tasks);

        using var roundTrip = new AppStateStore(dir.Path);
        var loaded = await roundTrip.LoadAsync(CancellationToken.None);
        loaded.ReviewSessions["o/r/1"].ViewedFiles.Should().HaveCount(50,
            because: "every concurrent transform must observe prior writes; no lost writes");
    }

    [Fact]
    public async Task UpdateAsync_throws_InvalidOperationException_when_in_read_only_mode()
    {
        using var dir = new TempDataDir();
        // Future-version state.json puts the store into read-only mode.
        await File.WriteAllTextAsync(Path.Combine(dir.Path, "state.json"), """
        {
          "version": 99,
          "review-sessions": {},
          "ai-state": { "repo-clone-map": {}, "workspace-mtime-at-last-enumeration": null },
          "last-configured-github-host": "https://github.com"
        }
        """);

        using var store = new AppStateStore(dir.Path);
        _ = await store.LoadAsync(CancellationToken.None);
        IAppStateStore @interface = store;
        @interface.IsReadOnlyMode.Should().BeTrue();

        var act = async () => await @interface.UpdateAsync(s => s, CancellationToken.None);
        await act.Should().ThrowAsync<InvalidOperationException>().WithMessage("*read-only mode*");
    }

    [Fact]
    public async Task IsReadOnlyMode_is_reachable_through_IAppStateStore_interface()
    {
        // P1.6: the endpoint code in PR4 talks to IAppStateStore (single-store via interface).
        // IsReadOnlyMode must surface on the interface, not just the concrete class.
        using var dir = new TempDataDir();
        IAppStateStore store = new AppStateStore(dir.Path);
        _ = await store.LoadAsync(CancellationToken.None);
        store.IsReadOnlyMode.Should().BeFalse();
    }
}
