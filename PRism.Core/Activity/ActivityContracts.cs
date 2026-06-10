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
    // Notification-only verbs (no received_event ever produces them, so they always
    // render as their own actorless row). Surfaced so a notification's `reason` is not
    // flattened into the generic "Other" bucket — it carries real meaning the rail shows.
    CiActivity,           // wire: "ci-activity"; notification reason "ci_activity" (actorless)
    Authored,             // wire: "authored"; notification reason "author" (actorless)
    // Enrichment verbs: a vague notification (Other/CiActivity/Authored) resolved to a real
    // actor + action via the batched GraphQL timeline query (IPrTimelineReader). The latest
    // timeline item's type/state maps here so the row reads "{actor} approved/pushed to #n".
    Approved,             // wire: "approved"; PullRequestReview state APPROVED
    ChangesRequested,     // wire: "changes-requested"; PullRequestReview state CHANGES_REQUESTED
    Pushed,               // wire: "pushed"; PullRequestCommit (commit author)
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
