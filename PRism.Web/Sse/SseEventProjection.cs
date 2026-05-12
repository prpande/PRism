using PRism.Core.Events;

namespace PRism.Web.Sse;

// Wire-shape projections — convert IReviewEvent records (which carry PrReference)
// into the JSON payload shape the frontend consumes (prRef as "owner/repo/number" string).
// Only the three S4-PR3 event types + the five S5-PR3 submit-* events use string-shaped prRef
// per spec § 4.5 / § 7.4–7.5; existing pr-updated / inbox-updated continue to serialize the
// event record directly so their wire contract is unchanged.
//
// Intentionally NOT in the switch: `DraftSubmitted` is declared in PRism.Core/Events and is
// published by the S5 PR3 submit endpoint, but `SseChannel` does not subscribe to it — the
// frontend learns a review was submitted via the `StateChanged` event that fires alongside.
// If a future change subscribes SseChannel to DraftSubmitted, add the
// `DraftSubmitted -> ("draft-submitted", ...)` arm here in lockstep so the default-arm
// `ArgumentOutOfRangeException` doesn't fire at runtime.
//
// Threat-model defense (spec § 7.4/§ 7.5/§ 17 #26): the submit-* payloads carry counts + the
// IDs the dialog UX needs and nothing more — no thread/reply bodies (those arrive only in the
// Resume endpoint's 200 response when the user explicitly opts in), no orphan review id, no
// pendingReviewId. The per-PR subscription is broader-than-spec (any subscribed tab sees the
// event), so keeping the payload minimal is the defense.
internal static class SseEventProjection
{
    internal sealed record StateChangedWire(string PrRef, IReadOnlyList<string> FieldsTouched, string? SourceTabId);
    internal sealed record DraftSavedWire(string PrRef, string DraftId, string? SourceTabId);
    internal sealed record DraftDiscardedWire(string PrRef, string DraftId, string? SourceTabId);

    // step / status serialize as the C# enum names (PascalCase) per spec § 18.2 decision.
    internal sealed record SubmitProgressWire(
        string PrRef, string Step, string Status, int Done, int Total, string? ErrorMessage);
    internal sealed record SubmitForeignPendingReviewWire(
        string PrRef, string PullRequestReviewId, string CommitOid, string CreatedAt, int ThreadCount, int ReplyCount);
    internal sealed record SubmitStaleCommitOidWire(string PrRef, string OrphanCommitOid);
    internal sealed record SubmitOrphanCleanupFailedWire(string PrRef);
    internal sealed record SubmitDuplicateMarkerDetectedWire(string PrRef, string DraftId);

    public static (string EventName, object Payload) Project(IReviewEvent evt) => evt switch
    {
        StateChanged e => ("state-changed", new StateChangedWire(e.PrRef.ToString(), e.FieldsTouched, e.SourceTabId)),
        DraftSaved e => ("draft-saved", new DraftSavedWire(e.PrRef.ToString(), e.DraftId, e.SourceTabId)),
        DraftDiscarded e => ("draft-discarded", new DraftDiscardedWire(e.PrRef.ToString(), e.DraftId, e.SourceTabId)),

        SubmitProgressBusEvent e => ("submit-progress", new SubmitProgressWire(
            e.PrRef.ToString(), e.Step.ToString(), e.Status.ToString(), e.Done, e.Total, e.ErrorMessage)),
        SubmitForeignPendingReviewBusEvent e => ("submit-foreign-pending-review", new SubmitForeignPendingReviewWire(
            e.PrRef.ToString(), e.PullRequestReviewId, e.CommitOid, e.CreatedAt.ToString("O"), e.ThreadCount, e.ReplyCount)),
        SubmitStaleCommitOidBusEvent e => ("submit-stale-commit-oid", new SubmitStaleCommitOidWire(
            e.PrRef.ToString(), e.OrphanCommitOid)),
        SubmitOrphanCleanupFailedBusEvent e => ("submit-orphan-cleanup-failed", new SubmitOrphanCleanupFailedWire(
            e.PrRef.ToString())),
        SubmitDuplicateMarkerDetectedBusEvent e => ("submit-duplicate-marker-detected", new SubmitDuplicateMarkerDetectedWire(
            e.PrRef.ToString(), e.DraftId)),

        _ => throw new ArgumentOutOfRangeException(nameof(evt), $"No SSE projection for {evt.GetType().Name}")
    };
}
