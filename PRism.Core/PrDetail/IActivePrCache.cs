using PRism.Core.Contracts;

namespace PRism.Core.PrDetail;

// Per-PR snapshot exposing the current head SHA and (where computable) the highest issue
// comment id. Populated by ActivePrPoller after each successful poll cycle. Consumed by
// PUT /draft (markAllRead) and POST /reload (head-shift detection) per spec § 4.6 + 4.7.
//
// HighestIssueCommentId is `null` in S4 production: ActivePrPoller's PollActivePrAsync path
// surfaces a comment count, not a comment id. The full markAllRead semantics that depend on
// a real id are deferred — see deferrals doc "PR3: HighestIssueCommentId not populated by
// poller (markAllRead is no-op in production until follow-up)". Tests inject a fake cache
// to exercise the success path.
public interface IActivePrCache
{
    bool IsSubscribed(PrReference prRef);
    ActivePrSnapshot? GetCurrent(PrReference prRef);
    void Update(PrReference prRef, ActivePrSnapshot snapshot);
}

public sealed record ActivePrSnapshot(
    string HeadSha,
    long? HighestIssueCommentId,
    DateTimeOffset ObservedAt);
