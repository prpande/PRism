using System;
using System.Collections.Generic;
using System.Linq;

namespace PRism.Core.Activity;

public readonly record struct ActivityBuildResult(
    IReadOnlyList<ActivityItem> Items,
    int DroppedRecognized);

public static class ActivityFeedBuilder
{
    public const int MaxRawItems = 50;       // server ceiling; client filters bots then caps to 12
    private const int WindowHours = 24;

    // Suffix-less bots that won't match the "[bot]" heuristic. Confirm exact login
    // at implementation (Copilot's received_events login lacked the suffix).
    private static readonly HashSet<string> KnownBots =
        new(StringComparer.OrdinalIgnoreCase) { "Copilot" };

    public static ActivityBuildResult Build(
        IReadOnlyList<RawReceivedEvent> events, DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(events);

        var dropped = 0;
        var cutoff = now.AddHours(-WindowHours);
        var byId = new Dictionary<string, ActivityItem>(StringComparer.Ordinal);

        foreach (var e in events)
        {
            var verb = MapVerb(e);
            if (verb is null) continue;                 // unmapped type → silent drop (not counted)

            // 24h window check FIRST so the dropped-recognized counter reflects only
            // IN-WINDOW payload drift, not stale events page 1 happens to carry.
            if (e.CreatedAt < cutoff) continue;

            // Recognized + in-window but missing the data that makes a row valid → drop + COUNT.
            if (string.IsNullOrEmpty(e.ActorLogin) || e.PrNumber is null || string.IsNullOrEmpty(e.HtmlUrl))
            {
                dropped++;
                continue;
            }

            // Event-id dedup: collapse a re-emitted duplicate (same GitHub event id),
            // but KEEP distinct ids even if same actor/verb/PR (real distinct activity).
            if (byId.ContainsKey(e.Id)) continue;

            byId[e.Id] = new ActivityItem(
                ActorLogin: e.ActorLogin,
                ActorAvatarUrl: e.ActorAvatarUrl,
                ActorIsBot: IsBot(e.ActorLogin),
                Verb: verb.Value,
                Repo: e.Repo,
                PrNumber: e.PrNumber.Value,
                Title: e.Title,
                Url: e.HtmlUrl,
                Timestamp: e.CreatedAt,
                Source: ActivitySource.ReceivedEvent);
        }

        var items = byId.Values
            .OrderByDescending(i => i.Timestamp)
            .Take(MaxRawItems)
            .ToList();

        return new ActivityBuildResult(items, dropped);
    }

    private static ActivityVerb? MapVerb(RawReceivedEvent e) => e.Type switch
    {
        "PullRequestReviewEvent" => ActivityVerb.Reviewed,
        "PullRequestReviewCommentEvent" => ActivityVerb.Commented,
        "IssueCommentEvent" when e.IsPullRequestComment => ActivityVerb.Commented,
        "PullRequestEvent" => e.Action switch
        {
            "opened" => ActivityVerb.Opened,
            "reopened" => ActivityVerb.Reopened,
            "closed" => e.Merged ? ActivityVerb.Merged : ActivityVerb.Closed,
            _ => null,
        },
        _ => null,
    };

    private static bool IsBot(string login) =>
        login.EndsWith("[bot]", StringComparison.OrdinalIgnoreCase) || KnownBots.Contains(login);
}
