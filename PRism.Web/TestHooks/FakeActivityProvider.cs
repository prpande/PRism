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
    private static readonly DateTimeOffset Base = new(2026, 6, 9, 12, 0, 0, TimeSpan.Zero);

    public Task<ActivityResponse> GetActivityAsync(CancellationToken ct)
    {
        ActivityItem It(string actor, bool bot, ActivityVerb verb, int pr, int minsAgo, string repo = "acme/api") =>
            new(actor, null, bot, verb, repo, pr, $"PR #{pr}",
                $"https://github.com/{repo}/pull/{pr}", Base.AddMinutes(-minsAgo), ActivitySource.ReceivedEvent);

        var items = new[]
        {
            It("noah.s", false, ActivityVerb.Reviewed, 1810, 38),
            It("alice", false, ActivityVerb.Commented, 5436, 60, "acme/pos"),
            It("Copilot", true, ActivityVerb.Reviewed, 1810, 40),
            It("jules.t", false, ActivityVerb.Reviewed, 1827, 120),
            It("rohit", false, ActivityVerb.Opened, 1842, 180),
            It("noah.s", false, ActivityVerb.Merged, 1815, 300),
        };
        return Task.FromResult(new ActivityResponse(items, Base, new ActivityDegradation(false)));
    }
}
