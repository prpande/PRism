using System;
using System.Threading;
using System.Threading.Tasks;
using PRism.Core.Activity;

namespace PRism.Web.TestHooks;

// Deterministic activity feed for Playwright visual baselines. Registered ONLY under
// ASPNETCORE_ENVIRONMENT=Test + PRISM_E2E_FAKE_REVIEW=1 (Program.cs swap) — never in
// Production. Mirrors FakeReviewAuth's role on the IActivityProvider seam. Returns a
// fixed human-dominant feed (bots present but hidden by the rail's default-off toggle).
internal sealed class FakeActivityProvider : IActivityProvider
{
    public Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        // Anchor to request-time "now" (NOT a fixed past date): the rail renders
        // formatAge() against the browser's real clock, so a fixed Base makes the
        // displayed ages ("6h ago") drift with wall-clock time between CI runs and
        // breaks the visual baseline. With a request-relative Base, each offset
        // renders as a stable bucket (38m / 1h / 2h / 3h / 5h ago); the only skew is
        // the sub-second server→render latency, far below formatAge's floor buckets.
        var now = DateTimeOffset.UtcNow;

        ActivityItem It(string actor, bool bot, ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(actor, null, bot, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", now.AddMinutes(-minsAgo), ActivitySource.ReceivedEvent);

        var items = new[]
        {
            It("noah.s", false, ActivityVerb.Reviewed, 1810, 38),
            It("alice", false, ActivityVerb.Commented, 5436, 60, "acme/pos"),
            It("Copilot", true, ActivityVerb.Reviewed, 1810, 40),
            It("jules.t", false, ActivityVerb.Reviewed, 1827, 120),
            It("rohit", false, ActivityVerb.Opened, 1842, 180),
            It("noah.s", false, ActivityVerb.Merged, 1815, 300),
        };
        return Task.FromResult(new ActivityResponse(items, now,
            new ActivityDegradation(false, Notifications: false, Watching: false), []));
    }
}
