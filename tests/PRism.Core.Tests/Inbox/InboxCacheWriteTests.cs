using FluentAssertions;
using PRism.Core.Inbox;
using PRism.Core.Storage;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxCacheWriteTests
{
    [Fact] // test 12 — write on Changed; no write on no-change/no-enrichment; write on enrichment-ready
    public async Task Writes_on_change_and_on_enrichment_ready_but_not_on_idle_tick()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var (orch, sections, events) = InboxOrchestratorTestHarness.Build(cache: cache, login: "octocat", host: "github.com");

        sections.Seed("mine", prNumber: 1);
        await orch.RefreshAsync(CancellationToken.None);          // Changed == true → one write
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().ContainSingle();
        cache.Saves.Single().Identity.Should().Be(new CacheIdentity("octocat", "github.com"));

        await orch.RefreshAsync(CancellationToken.None);          // identical tick, no new enrichment → no write
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().ContainSingle();                     // still exactly one

        InboxOrchestratorTestHarness.RaiseEnrichmentReady(events, "octocat/hello#1", chip: "needs-review");
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);
        cache.Saves.Should().HaveCount(2);                        // enrichment-ready flush
        cache.Saves.Last().Payload.AiEnrichmentSettled.Should().Contain("octocat/hello#1");
    }

    [Fact] // test 13 — captured-identity stamp: snapshot captured under A persists as A even if login flips to B before flush
    public async Task Coalesced_write_stamps_identity_captured_with_the_snapshot()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var login = new MutableLogin("alice");
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build(cache: cache, loginProvider: login.Get, host: "github.com");

        sections.Seed("mine", prNumber: 1);
        // Flip the login to B the instant the snapshot commits but before the coalesced write drains.
        login.OnNextRead = () => login.Value = "bob";
        await orch.RefreshAsync(CancellationToken.None);
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);

        cache.Saves.Single().Identity.Login.Should().Be("alice"); // stamped with the capture-time login, NOT bob
        cache.TryLoad(new CacheIdentity("bob", "github.com")).Should().BeNull();
    }

    [Fact] // test 13b (round-3 SCOPE-1/SEC-1) — the epoch gate DROPS a pre-invalidate write so evict can't be resurrected
    public async Task Invalidate_drops_a_write_captured_under_the_prior_epoch()
    {
        var cache = new RecordingIdentityCache<InboxSnapshot>();
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build(cache: cache, login: "octocat", host: "github.com");

        // Arm the one-shot hook: immediately after the drainer dequeues the epoch=0 write (but BEFORE
        // it reaches the epoch check), advance the epoch to 1. The drainer then sees `0 != 1` and drops
        // the write — the exact R2-ADV-1 resurrection guard. Using the hook rather than a race against
        // Task.Run startup guarantees the epoch bumps at the deterministic moment inside the drainer.
        orch.TestAfterDequeueHook = () => orch.TestBumpEpoch();

        sections.Seed("mine", prNumber: 1);
        await orch.RefreshAsync(CancellationToken.None);
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);

        // Without the drainer's `if (next.Epoch != Volatile.Read(ref _cacheWriteEpoch)) continue;` line this
        // would record a save — the exact R2-ADV-1 resurrection. The gate must leave Saves empty.
        cache.Saves.Should().BeEmpty();
    }
}
