using PRism.Core.Activity;
using PRism.Core.Contracts;

namespace PRism.Web.TestHooks;

// Test-only IPrTimelineFeedReader (#620 e2e-fidelity gap). Without this fake, the real
// GitHubPrTimelineFeedReader resolves under PRISM_E2E_FAKE_REVIEW=1 and 502s (no GitHub
// token in e2e), so the Overview feed always rendered its `timeline-error` state in
// Playwright — every scenario spec exercising the feed was hollow-green. Mirrors
// FakeActivityProvider's role: stateless, request-time-anchored, dependency-free.
//
// Returns ONE page for the canonical scenario PR (acme/api/123) covering every node
// type ActivityFeed renders: two body-bearing comments (timeline-comment cards), one
// bodyless approval (timeline-marker), a 3-commit push run (timeline-commit-group), and
// the synthesized Opened event as the oldest element (HasOlder: false). Any other
// PrReference gets an empty, non-degraded page — mirroring FakePrReader's `!= Scenario`
// guards elsewhere in this split.
internal sealed class FakePrTimelineFeedReader : IPrTimelineFeedReader
{
    public Task<TimelinePage> ReadPageAsync(PrReference prRef, string? cursor, int pageSize, CancellationToken ct)
    {
        if (prRef != FakeReviewBackingStore.Scenario)
            return Task.FromResult(new TimelinePage(Array.Empty<TimelineEvent>(), null, false));

        // Anchor to request-time "now" (not a fixed past date) so relative-age rendering
        // (formatAge) stays stable across CI runs — same rationale as FakeActivityProvider.
        var now = DateTimeOffset.UtcNow;

        var alice = new TimelineActorRef("alice", null, false);
        var noah = new TimelineActorRef("noah.s", null, false);
        var e2eUser = new TimelineActorRef("e2e-user", null, false);

        // Mirrors FakeReviewBackingStore's Sha1/Sha2/Sha3 (private there, so re-declared
        // here as literals rather than adding a dependency — see the class doc above).
        const string sha1 = "1111111111111111111111111111111111111111"; // "Add Calc.Add"
        const string sha2 = "2222222222222222222222222222222222222222"; // "Add Sub + Mul"
        const string sha3 = "3333333333333333333333333333333333333333"; // "Add Div + Mod"

        var events = new[]
        {
            // Newest: two body-bearing comments → render as timeline-comment cards.
            new TimelineEvent("comment:2", ActivityVerb.Commented, noah, now.AddMinutes(-2),
                "Pushed the fix, PTAL.", null, null),
            new TimelineEvent("comment:1", ActivityVerb.Commented, alice, now.AddMinutes(-5),
                "Looks good — one nit on the Div guard.", null, null),

            // One bodyless approval → renders as a timeline-marker with the state band.
            new TimelineEvent("review:1", ActivityVerb.Approved, alice, now.AddMinutes(-15),
                null, null, null),

            // Three pushes reusing the scenario shas/messages → one timeline-commit-group.
            new TimelineEvent($"push:{sha3}", ActivityVerb.Pushed, e2eUser, now.AddMinutes(-30), null, 1, null),
            new TimelineEvent($"push:{sha2}", ActivityVerb.Pushed, e2eUser, now.AddMinutes(-40), null, 1, null),
            new TimelineEvent($"push:{sha1}", ActivityVerb.Pushed, e2eUser, now.AddMinutes(-50), null, 1, null),

            // Oldest: synthesized Opened, mirroring the real reader's SynthesizeOpened
            // (only emitted because HasOlder is false below).
            new TimelineEvent("opened:e2e-user", ActivityVerb.Opened, e2eUser, now.AddMinutes(-60),
                null, null, null),
        };

        // Already authored newest-first above; re-sort defensively to match the real
        // reader's stable OrderByDescending(Timestamp).ThenByDescending(Id) contract.
        var ordered = events
            .OrderByDescending(e => e.Timestamp)
            .ThenByDescending(e => e.Id, StringComparer.Ordinal)
            .ToList();

        return Task.FromResult(new TimelinePage(ordered, OlderCursor: null, HasOlder: false));
    }
}
