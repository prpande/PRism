namespace PRism.Core.Activity;

// reason → ActivityVerb. you-relevant reasons (review_requested/mention) map to verbs the
// event side NEVER produces, so a you-relevant notification is always alone in its
// (Repo,Pr,Verb) group and renders as its own actorless row by design (see ActivityFeedBuilder
// Stage B rationale). `comment` maps to Commented (a shared verb) so a non-you-relevant comment
// notification collapses with a comment event. ci_activity and author map to notification-only
// verbs (CiActivity/Authored) so the rail can label them precisely ("Checks ran on", "Update on
// your PR") instead of flattening them into a generic "update" — both reasons are common and
// carry real meaning. state_change is deliberately NOT disambiguated to Opened/Closed/Merged — a
// notification can't tell which, and a wrong-verb merge is worse than a separate "updated" row —
// so it falls to Other. subscribed/manual/unknown → Other.
public static class NotificationReasonMap
{
    public static ActivityVerb ToVerb(string? reason) => reason switch
    {
        "review_requested" => ActivityVerb.ReviewRequested,
        "mention" or "team_mention" => ActivityVerb.Mentioned,
        "comment" => ActivityVerb.Commented,
        "ci_activity" => ActivityVerb.CiActivity,
        "author" => ActivityVerb.Authored,
        _ => ActivityVerb.Other,
    };

    public static bool IsYouRelevant(ActivityVerb verb)
        => verb is ActivityVerb.ReviewRequested or ActivityVerb.Mentioned;

    // Vague notification verbs worth enriching with a real actor/action from the PR timeline.
    // Excludes you-relevant (Mentioned/ReviewRequested — kept as their own actorless lead) and
    // Commented (already specific, folds into a matching comment event).
    public static bool IsEnrichmentCandidate(ActivityVerb verb)
        => verb is ActivityVerb.Other or ActivityVerb.CiActivity or ActivityVerb.Authored;
}
