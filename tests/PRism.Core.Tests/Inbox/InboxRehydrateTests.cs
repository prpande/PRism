using FluentAssertions;
using PRism.Core.Events;
using PRism.Core.Inbox;
using Xunit;

namespace PRism.Core.Tests.Inbox;

public sealed class InboxRehydrateTests
{
    [Fact] // test 9 — TryRehydrate sets Current + completes the first-snapshot gate + arms force-notify
    public async Task TryRehydrate_sets_current_and_completes_first_snapshot_gate()
    {
        var (orch, _, _) = InboxOrchestratorTestHarness.Build();
        var snap = InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 7);

        orch.TryRehydrate(snap);

        orch.Current.Should().BeSameAs(snap);
        orch.IsServingRehydratedSnapshot.Should().BeTrue();
        (await orch.WaitForFirstSnapshotAsync(TimeSpan.FromMilliseconds(50), CancellationToken.None))
            .Should().BeTrue(); // returns without a refresh
    }

    [Fact] // test 10 — TryRehydrate no-ops if a refresh already committed
    public async Task TryRehydrate_no_ops_when_current_already_set()
    {
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build();
        sections.Seed("mine", prNumber: 1);
        await orch.RefreshAsync(CancellationToken.None);
        var live = orch.Current;

        orch.TryRehydrate(InboxOrchestratorTestHarness.SnapshotWith("mine", prNumber: 99));

        orch.Current.Should().BeSameAs(live);              // live retained
        orch.IsServingRehydratedSnapshot.Should().BeFalse(); // never armed
    }

    [Fact] // test 11 — first successful refresh after rehydrate force-notifies even on no-change, then clears
    public async Task First_refresh_after_rehydrate_force_notifies_then_clears()
    {
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build();
        // Rehydrate with a snapshot equal to what the live refresh will produce → diff.Changed == false.
        sections.Seed("mine", prNumber: 5);
        var rehydrated = await InboxOrchestratorTestHarness.BuildEquivalentSnapshotAsync(sections);
        var (orch2, sections2, events2) = InboxOrchestratorTestHarness.Build();
        sections2.Seed("mine", prNumber: 5);
        orch2.TryRehydrate(rehydrated);
        events2.Clear();

        await orch2.RefreshAsync(CancellationToken.None);

        // Round-1 ADV-5: assert the publish came from the FORCE-NOTIFY branch, not a diff.Changed branch
        // (both publish exactly one InboxUpdated, so ContainSingle alone can't distinguish them). The
        // force-notify payload is NewOrUpdatedPrCount==0 over the full Sections.Keys set.
        var published = events2.Published.OfType<InboxUpdated>().Should().ContainSingle().Subject;
        published.NewOrUpdatedPrCount.Should().Be(0);                      // no real delta → proves force-notify
        published.ChangedSectionIds.Should().BeEquivalentTo(rehydrated.Sections.Keys);
        orch2.IsServingRehydratedSnapshot.Should().BeFalse();              // flag cleared

        events2.Clear();
        await orch2.RefreshAsync(CancellationToken.None);
        events2.Published.OfType<InboxUpdated>().Should().BeEmpty();       // subsequent no-change refresh is silent
    }

    [Fact] // test 14 — first refresh after rehydrate diffs against the rehydrated snapshot (real delta, not "everything new")
    public async Task First_refresh_after_rehydrate_diffs_against_rehydrated_not_null()
    {
        var (orch, sections, _) = InboxOrchestratorTestHarness.Build();
        sections.Seed("mine", prNumber: 5);
        var rehydrated = await InboxOrchestratorTestHarness.BuildEquivalentSnapshotAsync(sections);
        var (orch2, sections2, events2) = InboxOrchestratorTestHarness.Build();
        sections2.Seed("mine", prNumber: 5);
        sections2.Seed("mine", prNumber: 6); // one genuinely new PR
        orch2.TryRehydrate(rehydrated);
        events2.Clear();

        await orch2.RefreshAsync(CancellationToken.None);

        var updated = events2.Published.OfType<InboxUpdated>().Single();
        updated.NewOrUpdatedPrCount.Should().Be(1); // only the real delta, NOT CountAll(everything)
    }
}
