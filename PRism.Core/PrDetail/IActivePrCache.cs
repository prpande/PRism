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

    /// <summary>
    /// Drops every cached snapshot. Called by <c>POST /api/auth/replace</c> when the
    /// identity-change rule fires (spec § 3.3) so the next per-PR poll cycle re-reads
    /// fresh state under the new identity rather than serving stale snapshots tied to
    /// the prior login's GitHub Node IDs. Subscriber registry membership is NOT
    /// touched here — <see cref="ActivePrSubscriberRegistry.RemoveAll"/> is the
    /// matching wipe on the registry side and is called alongside.
    /// </summary>
    void Clear();
}

public sealed record ActivePrSnapshot(
    string HeadSha,
    long? HighestIssueCommentId,
    DateTimeOffset ObservedAt,
    string BaseSha = "");
