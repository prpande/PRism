using System;
using System.Collections.Generic;
using System.Linq;

namespace PRism.Core.Activity;

public readonly record struct ActivityBuildResult(
    IReadOnlyList<ActivityItem> Items,
    int DroppedRecognized,
    IReadOnlyList<WatchedRepoActivity> Watching);

public static class ActivityFeedBuilder
{
    public const int MaxActivityItems = 12; // must match frontend MAX_VISIBLE (ActivityRail.tsx) — the VISIBLE cap; slot reservation is baked against this, not MaxRawItems
    public const int MaxRawItems = 50;       // server ceiling; client filters bots then caps to MaxActivityItems
    public const int MinEventSlots = 4;      // non-bot event rows reserved inside the visible window
    public const int MaxWatchingRows = 8;
    private const int WindowHours = 24;

    // Suffix-less bots that won't match the "[bot]" heuristic (Copilot's received_events
    // login lacked the suffix). Always-on built-in baseline; user-configured extras are
    // ADDITIVE on top (see Build) — a user can never accidentally un-detect Copilot.
    private static readonly HashSet<string> BuiltInBots =
        new(StringComparer.OrdinalIgnoreCase) { "Copilot" };

    // Phase-1 single-source overload: thin delegate to the multi-source build so the
    // P1 tests stay green (no notifications, no watched repos, default host, no extra bots).
    public static ActivityBuildResult Build(
        IReadOnlyList<RawReceivedEvent> events, DateTimeOffset now)
        => Build(events, [], [], "https://github.com", [], now);

    public static ActivityBuildResult Build(
        IReadOnlyList<RawReceivedEvent> events,
        IReadOnlyList<RawNotification> notifications,
        IReadOnlyList<string> watchedRepos,
        string host,                 // FULL configured GitHub host URL incl. scheme, e.g. "https://github.com" — NOT a bare hostname; URLs build as $"{host}/..."
        IReadOnlyCollection<string> extraBotLogins,  // user-configured extra bot logins; ADDITIVE on top of BuiltInBots
        DateTimeOffset now)
    {
        ArgumentNullException.ThrowIfNull(events);
        ArgumentNullException.ThrowIfNull(notifications);
        ArgumentNullException.ThrowIfNull(watchedRepos);
        ArgumentNullException.ThrowIfNull(host);
        ArgumentNullException.ThrowIfNull(extraBotLogins);

        var bots = new HashSet<string>(BuiltInBots, StringComparer.OrdinalIgnoreCase);
        bots.UnionWith(extraBotLogins);

        var cutoff = now.AddHours(-WindowHours);

        var (eventItems, dropped) = BuildEventItems(events, cutoff, bots);
        var notifItems = BuildNotificationItems(notifications, cutoff, host);

        // Two-stage cross-feed merge keyed on (Repo, PrNumber, Verb).
        var merged = MergeFeeds(eventItems, notifItems);

        // Watching is computed BEFORE the visible cap so a repo whose activity sits
        // above the 12-cap never falsely shows as idle.
        var watching = BuildWatching(merged, watchedRepos, host);

        // Sort newest-first, then bake the slot reservation into the server's order so the
        // client's first-MaxActivityItems slice (after its bot filter) keeps >=MinEventSlots
        // non-bot event rows. Finally cap to the raw ceiling.
        // Deterministic tiebreakers (Url ordinal, then Source) keep equal-timestamp rows in a
        // runtime-stable order independent of dictionary/group enumeration, protecting the e2e
        // visual baseline from same-second nondeterminism.
        var sorted = merged
            .OrderByDescending(i => i.Timestamp)
            .ThenBy(i => i.Url, StringComparer.Ordinal)
            .ThenBy(i => i.Source)
            .ToList();

        // The visible order is intentionally NOT strictly newest-first: ReserveEventSlots may
        // promote reserved non-bot events above fresher notifications (reservation beats strict
        // recency, by design). The client renders this order verbatim — no client-side re-sort.
        var ordered = ReserveEventSlots(sorted).Take(MaxRawItems).ToList();

        return new ActivityBuildResult(ordered, dropped, watching);
    }

    private static (List<ActivityItem> Items, int Dropped) BuildEventItems(
        IReadOnlyList<RawReceivedEvent> events, DateTimeOffset cutoff, HashSet<string> bots)
    {
        var dropped = 0;
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
                ActorIsBot: IsBot(e.ActorLogin, bots),
                Verb: verb.Value,
                Repo: e.Repo,
                PrNumber: e.PrNumber.Value,
                Title: e.Title,
                Url: e.HtmlUrl,
                Timestamp: e.CreatedAt,
                Source: ActivitySource.ReceivedEvent);
        }

        return ([.. byId.Values], dropped);
    }

    private static List<ActivityItem> BuildNotificationItems(
        IReadOnlyList<RawNotification> notifications, DateTimeOffset cutoff, string host)
    {
        var items = new List<ActivityItem>();
        foreach (var n in notifications)
        {
            if (n.Timestamp < cutoff) continue;          // window-filter notifications too

            items.Add(new ActivityItem(
                ActorLogin: null,
                ActorAvatarUrl: null,
                ActorIsBot: false,                       // a notification has NO actor — never bot-flagged
                Verb: NotificationReasonMap.ToVerb(n.Reason),
                Repo: n.Repo,
                PrNumber: n.PrNumber,
                Title: n.Title,
                Url: $"{host}/{n.Repo}/pull/{n.PrNumber}",
                Timestamp: n.Timestamp,
                Source: ActivitySource.Notification));
        }

        return items;
    }

    private static List<ActivityItem> MergeFeeds(
        List<ActivityItem> eventItems, List<ActivityItem> notifItems)
    {
        var merged = new List<ActivityItem>();
        foreach (var g in eventItems.Concat(notifItems).GroupBy(Key))
        {
            var evs = g.Where(i => i.Source == ActivitySource.ReceivedEvent).ToList();
            merged.AddRange(evs);                                  // distinct actors all survive

            // Collapse GitHub's re-emitted notifications for the same (repo, reason, PR)
            // down to the most-recent one before deciding whether it earns a row.
            var nf = g.Where(i => i.Source == ActivitySource.Notification)
                      .OrderByDescending(i => i.Timestamp)
                      .FirstOrDefault();
            if (nf is null) continue;

            if (NotificationReasonMap.IsYouRelevant(nf.Verb))
            {
                merged.Add(nf);                                   // own actorless row (verb has no event counterpart)
                continue;
            }

            if (evs.Count == 0) merged.Add(nf);                   // no event to fold into → keep as the single row
            // else: non-you-relevant notification folds into the most-recent matching event (drop, no new row)
        }

        return merged;

        static (string, int, ActivityVerb) Key(ActivityItem i) => (i.Repo, i.PrNumber, i.Verb);
    }

    // Bake the visible-window slot reservation into the server's order: the client takes
    // the first MaxActivityItems (after stripping bots) WITHOUT re-sorting, so the reserve
    // must land inside that window. Take the top (MaxActivityItems - MinEventSlots) by
    // timestamp, then promote the most-recent NON-BOT events not yet chosen to fill the
    // reserved slots up to MaxActivityItems, then append the remainder by timestamp.
    // Reserve NON-BOT events (Source==ReceivedEvent && !ActorIsBot) because the client
    // strips bots before slicing; bot events filling the reserve would vanish client-side.
    private static List<ActivityItem> ReserveEventSlots(List<ActivityItem> sorted)
    {
        if (sorted.Count <= MaxActivityItems) return sorted;

        var headCount = MaxActivityItems - MinEventSlots;         // unconditional top slots
        var ordered = new List<ActivityItem>(sorted.Count);
        var taken = new HashSet<ActivityItem>(ReferenceEqualityComparer.Instance);

        foreach (var item in sorted.Take(headCount))
        {
            ordered.Add(item);
            taken.Add(item);
        }

        // Fill the reserved slots with the most-recent non-bot events not already chosen.
        var reservedHere = ordered.Count(IsNonBotEvent);
        foreach (var ev in sorted.Where(i => IsNonBotEvent(i) && !taken.Contains(i)))
        {
            if (ordered.Count >= MaxActivityItems || reservedHere >= MinEventSlots) break;
            ordered.Add(ev);
            taken.Add(ev);
            reservedHere++;
        }

        // Append everything else in timestamp order.
        foreach (var item in sorted.Where(i => !taken.Contains(i)))
        {
            ordered.Add(item);
        }

        return ordered;

        static bool IsNonBotEvent(ActivityItem i)
            => i.Source == ActivitySource.ReceivedEvent && !i.ActorIsBot;
    }

    private static List<WatchedRepoActivity> BuildWatching(
        List<ActivityItem> merged, IReadOnlyList<string> watchedRepos, string host)
    {
        var counts = merged
            .GroupBy(i => i.Repo, StringComparer.Ordinal)
            .ToDictionary(g => g.Key, g => g.Count(), StringComparer.Ordinal);

        return watchedRepos
            .Select(repo => new WatchedRepoActivity(
                Repo: repo,
                Count: counts.TryGetValue(repo, out var c) ? c : 0,
                Url: $"{host}/{repo}"))
            .OrderByDescending(w => w.Count)
            .ThenBy(w => w.Repo, StringComparer.Ordinal)
            .Take(MaxWatchingRows)
            .ToList();
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

    private static bool IsBot(string login, HashSet<string> bots) =>
        login.EndsWith("[bot]", StringComparison.OrdinalIgnoreCase) || bots.Contains(login);
}
