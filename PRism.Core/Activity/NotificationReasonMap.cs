namespace PRism.Core.Activity;

// reason → ActivityVerb. you-relevant reasons (review_requested/mention) map to verbs the
// event side NEVER produces, so a you-relevant notification is always alone in its
// (Repo,Pr,Verb) group and renders as its own actorless row by design (see ActivityFeedBuilder
// Stage B rationale). `comment` maps to Commented (a shared verb) so a non-you-relevant comment
// notification collapses with a comment event. state_change is deliberately NOT disambiguated to
// Opened/Closed/Merged — a notification can't tell which, and a wrong-verb merge is worse than a
// separate "updated" row — so it falls to Other. subscribed/unknown → Other.
public static class NotificationReasonMap
{
    public static ActivityVerb ToVerb(string? reason) => reason switch
    {
        "review_requested" => ActivityVerb.ReviewRequested,
        "mention" or "team_mention" => ActivityVerb.Mentioned,
        "comment" => ActivityVerb.Commented,
        _ => ActivityVerb.Other,
    };

    public static bool IsYouRelevant(ActivityVerb verb)
        => verb is ActivityVerb.ReviewRequested or ActivityVerb.Mentioned;
}
