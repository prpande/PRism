using System;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.Web.TestHooks;

// Deterministic activity feed for Playwright visual baselines. Registered ONLY under
// ASPNETCORE_ENVIRONMENT=Test + PRISM_E2E_FAKE_REVIEW=1 (Program.cs swap) — never in
// Production. Mirrors FakeReviewAuth's role on the IActivityProvider seam. Returns a
// fixed human-dominant feed (bots present but hidden by the rail's default-off toggle)
// plus actorless notification rows (one per you-relevant verb) and a Watching list.
internal sealed class FakeActivityProvider : IActivityProvider
{
    // No-op: the fake feed is stateless (no cache to invalidate on token rotation).
    public void Reset() { /* stateless fake */ }

    public Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        // Anchor to request-time "now" (NOT a fixed past date): the rail renders
        // formatAge() against the browser's real clock, so a fixed Base makes the
        // displayed ages ("6h ago") drift with wall-clock time between CI runs and
        // breaks the visual baseline. With a request-relative Base, each offset
        // renders as a stable bucket (38m / 1h / 2h / 3h / 5h ago); the only skew is
        // the sub-second server→render latency, far below formatAge's floor buckets.
        var now = DateTimeOffset.UtcNow;

        ActivityItem Ev(string actor, bool bot, ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(actor, null, bot, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", now.AddMinutes(-minsAgo), ActivitySource.ReceivedEvent);
        ActivityItem Nf(ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(null, null, false, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", now.AddMinutes(-minsAgo), ActivitySource.Notification);

        var items = new[]
        {
            Nf(ActivityVerb.ReviewRequested, 1842, 12),                 // "Review requested on #1842"
            Ev("noah.s", false, ActivityVerb.Reviewed, 1810, 38),
            Ev("alice", false, ActivityVerb.Commented, 5436, 60, "acme/pos"),
            Ev("Copilot", true, ActivityVerb.Reviewed, 1810, 40),
            Nf(ActivityVerb.Mentioned, 1827, 75),                       // "You were mentioned in #1827"
            Ev("jules.t", false, ActivityVerb.Reviewed, 1827, 120),
            Ev("rohit", false, ActivityVerb.Opened, 1842, 180),
            Ev("noah.s", false, ActivityVerb.Merged, 1815, 300),
        };
        var watching = new[]
        {
            new WatchedRepoActivity("acme/api", 5, "https://github.com/acme/api"),
            new WatchedRepoActivity("acme/pos", 1, "https://github.com/acme/pos"),
            new WatchedRepoActivity("acme/infra", 0, "https://github.com/acme/infra"),  // idle
        };
        return Task.FromResult(new ActivityResponse(
            items, now, new ActivityDegradation(false, false, false), watching));
    }
}
