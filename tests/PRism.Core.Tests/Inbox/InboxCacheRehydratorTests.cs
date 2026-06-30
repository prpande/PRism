using FluentAssertions;
using Microsoft.Extensions.Logging.Abstractions;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxCacheRehydratorTests
{
    [Fact] // test 15a — present cache + non-empty matching config identity → rehydrates
    public async Task Rehydrates_when_cache_matches_nonempty_config_identity()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var snap = InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 7);
        await cache.SaveAsync(snap, new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: "octocat", host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeSameAs(snap);
        orch.IsServingRehydratedSnapshot.Should().BeTrue();
    }

    [Fact] // test 15b — empty config identity (first connect not persisted) → fails closed
    public async Task Fails_closed_when_config_identity_empty()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        await cache.SaveAsync(InboxOrchestratorTestHarness.SnapshotWith("mine", 7),
            new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: null, host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeNull(); // skeleton → live
    }

    [Fact] // test 15c — owner mismatch → fails closed
    public async Task Fails_closed_when_owner_mismatches_config()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        await cache.SaveAsync(InboxOrchestratorTestHarness.SnapshotWith("mine", 7),
            new CacheIdentity("octocat", "github.com"), CancellationToken.None);

        var (orch, _, _) = InboxOrchestratorTestHarness.Build(cache: cache);
        var config = InboxOrchestratorTestHarness.ConfigWith(login: "someone-else", host: "github.com");
        var sut = new InboxCacheRehydrator(orch, cache, config, NullLogger<InboxCacheRehydrator>.Instance);

        await sut.StartAsync(CancellationToken.None);

        orch.Current.Should().BeNull();
    }
}
