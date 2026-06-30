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
        // A gating batch reader lets us drive the precise interleaving WITHOUT any production
        // test hook: the orchestrator captures the write-epoch at line-175 (epoch 0) BEFORE calling
        // _batchReader.ReadAsync, so blocking the read parks the refresh right after the capture.
        var gate = new InboxOrchestratorTestHarness.GatingBatchReader();
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build(
            cache: cache, login: "octocat", host: "github.com", batchReader: gate);

        sections.Seed("mine", prNumber: 1);

        // Start the refresh but do NOT await — it blocks inside ReadAsync, after epoch 0 was captured.
        var refresh = orch.RefreshAsync(CancellationToken.None);
        await gate.ReadStarted; // the read is now parked; the in-flight refresh holds epoch 0

        // Call the REAL invalidate (the auth token-rotation seam): bumps epoch 0→1, clears the
        // (still-empty) queue, awaits the idle loop, returns. This is what makes the test guard the
        // ACTUAL Interlocked.Increment in InvalidateCacheWritesAsync, not a synthetic bump.
        await orch.InvalidateCacheWritesAsync();

        // Release the read → refresh completes, trigger (a) schedules the write stamped with the
        // captured epoch 0. The drainer then sees 0 != 1 (current epoch) and drops it.
        gate.Release();
        await refresh;
        await InboxOrchestratorTestHarness.WaitForCacheWriteIdleAsync(orch);

        // Falsification surface (the whole point of this test): delete the drainer's
        // `if (next.Epoch != Volatile.Read(ref _cacheWriteEpoch)) continue;` line → the write lands.
        // Delete the `Interlocked.Increment(ref _cacheWriteEpoch)` in InvalidateCacheWritesAsync →
        // epoch stays 0, drainer sees 0 == 0 → the write lands. Either way this assertion fails.
        cache.Saves.Should().BeEmpty();
    }
}
