using System.Collections.Generic;
using System.Diagnostics.CodeAnalysis;

namespace PRism.Core.Activity;

// Wire enums serialize kebab-case to match the architectural invariant (see how
// CiStatus serializes — JsonStringEnumConverter + KebabCaseLower naming). For P1
// every ActivityVerb is a single lowercase word, so kebab == lowercase; the
// endpoint test in Task 5 asserts the wire value and fails red if the converter
// is missing.
public enum ActivitySource
{
    ReceivedEvent,        // wire: "received-event"
    Notification,         // wire: "notification"
}

public enum ActivityVerb
{
    Opened, Reopened, Closed, Merged, Reviewed, Commented, Other,
    // NB: no Pushed — PushEvent has no PR number and `synchronize` is filtered
    // from the Events API (see spec § Scope).
    ReviewRequested,      // wire: "review-requested"; notification reason "review_requested" (actorless)
    Mentioned,            // wire: "mentioned"; notification reason "mention"/"team_mention" (actorless)
}

// Every Phase-1 item is PR-anchored and carries an actor (events always do).
// ActorLogin/ActorAvatarUrl are nullable only so P2 notification rows (no actor)
// fit the same record additively.
[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
public sealed record ActivityItem(
    string? ActorLogin,
    string? ActorAvatarUrl,
    bool ActorIsBot,
    ActivityVerb Verb,
    string Repo,
    int PrNumber,
    string? Title,
    string Url,
    System.DateTimeOffset Timestamp,
    ActivitySource Source);

public sealed record ActivityDegradation(bool ReceivedEvents, bool Notifications, bool Watching);

[SuppressMessage("Design", "CA1054:Uri parameters should not be strings",
    Justification = "URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
[SuppressMessage("Design", "CA1056:Uri properties should not be strings",
    Justification = "URL strings from the GitHub API; System.Uri is unnecessary overhead for wire records.")]
public sealed record WatchedRepoActivity(string Repo, int Count, string Url);

public sealed record ActivityResponse(
    IReadOnlyList<ActivityItem> Items,
    System.DateTimeOffset GeneratedAt,
    ActivityDegradation Degraded,
    IReadOnlyList<WatchedRepoActivity> Watching);
