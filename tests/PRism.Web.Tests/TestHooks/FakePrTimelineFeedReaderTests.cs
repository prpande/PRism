using FluentAssertions;
using PRism.Core.Activity;
using PRism.Core.Contracts;
using PRism.Web.TestHooks;

namespace PRism.Web.Tests.TestHooks;

// Closes the #620 e2e-fidelity gap: without a fake IPrTimelineFeedReader registered
// under PRISM_E2E_FAKE_REVIEW=1, the real GitHubPrTimelineFeedReader resolves and 502s
// in Playwright (no GitHub token in e2e), so the Overview feed always rendered its
// error state. This test asserts the fake's output shape directly; the Playwright specs
// (pr-detail-timeline.spec.ts + parity-baselines.spec.ts's pr-detail-overview) cover the
// resulting rendered feed.
public sealed class FakePrTimelineFeedReaderTests
{
    private static readonly PrReference OtherPr = new("acme", "api", 999);

    [Fact]
    public async Task ReadPageAsync_returns_every_node_type_for_the_scenario_pr()
    {
        var reader = new FakePrTimelineFeedReader();

        var page = await reader.ReadPageAsync(FakeReviewBackingStore.Scenario, cursor: null, pageSize: 30, CancellationToken.None);

        page.Degraded.Should().BeFalse();
        page.HasOlder.Should().BeFalse();
        page.OlderCursor.Should().BeNull();
        page.Events.Should().NotBeEmpty();

        page.Events.Should().Contain(e => e.Verb == ActivityVerb.Commented && e.Body != null);
        page.Events.Should().Contain(e => e.Verb == ActivityVerb.Approved && e.Body == null);
        page.Events.Should().Contain(e => e.Verb == ActivityVerb.Pushed && e.CommitCount == 1);
        page.Events.Should().Contain(e => e.Verb == ActivityVerb.Opened);

        // The synthesized Opened node is the oldest element, matching the real reader's
        // contract when HasOlder is false.
        page.Events[^1].Verb.Should().Be(ActivityVerb.Opened);
    }

    [Fact]
    public async Task ReadPageAsync_returns_empty_non_degraded_page_for_a_different_pr()
    {
        var reader = new FakePrTimelineFeedReader();

        var page = await reader.ReadPageAsync(OtherPr, cursor: null, pageSize: 30, CancellationToken.None);

        page.Events.Should().BeEmpty();
        page.HasOlder.Should().BeFalse();
        page.OlderCursor.Should().BeNull();
        page.Degraded.Should().BeFalse();
    }
}
