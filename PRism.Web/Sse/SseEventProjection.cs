using PRism.Core.Contracts;
using PRism.Core.Events;

namespace PRism.Web.Sse;

// Wire-shape projections — convert IReviewEvent records (which carry PrReference)
// into the JSON payload shape the frontend consumes (prRef as "owner/repo/number" string).
// The three S4-PR3 event types, the five S5-PR3 submit-* events, and pr-updated all use
// string-shaped prRef per spec § 4.5 / § 7.4–7.5. pr-updated was added to this switch in
// the wire-fix PR — it previously serialized the raw ActivePrUpdated record, shipping prRef
// as an object the frontend silently dropped (see docs/specs/2026-05-19-stale-oid-banner-
// investigation-finding.md). inbox-updated still serializes its record directly: it is
// broadcast (not per-PR) and its frontend contract already matches the raw shape.
//
// #392: `DraftSubmitted` IS now in the switch. It is published on a full review-submit success
// (after the pipeline's server-side draft clear); `SseChannel` subscribes to it and fans it out
// per-PR as `draft-submitted`, which the frontend uses to invalidate-and-reload the PR detail so
// the just-posted threads + Overview comment surface without a manual reload. The payload is
// `prRef` only — the submit already posted everything server-side, so no review/comment id ships
// (consistent with the submit-* threat-model defense below).
//
// Threat-model defense (spec § 7.4/§ 7.5/§ 17 #26): the submit-* payloads carry counts + the
// minimum IDs the dialog UX needs and nothing more. No thread/reply bodies (those arrive only in
// the Resume endpoint's 200 response when the user explicitly opts in). No orphan review id —
// `submit-stale-commit-oid` carries only the orphan *commit* oid; `submit-orphan-cleanup-failed`
// carries no id at all. The one review *node* id that does ship is on `submit-foreign-pending-
// review` (`pullRequestReviewId`) — the dialog needs it to call `/resume` and `/discard`, and it
// is the *foreign* review's id, not a PRism-managed `PendingReviewId` (the kind SensitiveFieldScrubber
// redacts). The per-PR subscription is broader-than-spec (any subscribed tab sees the event), so
// keeping the payload minimal is the defense — that one foreign-review id is the irreducible minimum.
internal static class SseEventProjection
{
    // MergeReadiness serializes kebab-case (e.g. "behind-base"), NOT an int: every SSE write path
    // (SseChannel.OnActivePrUpdated / FanoutProjected) serializes the projection payload with
    // JsonSerializerOptionsFactory.Api, whose JsonStringEnumConverter(KebabCaseJsonNamingPolicy)
    // emits the kebab string the frontend MergeReadiness union matches. See SseSerializationTests.
    internal sealed record ActivePrUpdatedWire(
        string PrRef, string? NewHeadSha, bool HeadShaChanged, int CommentCountDelta,
        bool IsMerged, bool IsClosed, bool BaseShaChanged, string? NewBaseSha,
        MergeReadiness MergeReadiness, bool MergeReadinessChanged, int? Approvals, int? ChangesRequested,
        // #593 — live reviewer name-lists for the detail readiness popover.
        IReadOnlyList<Reviewer>? Approvers, IReadOnlyList<Reviewer>? ChangesRequestedBy,
        IReadOnlyList<Reviewer>? AwaitingReviewers);
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

    // Task 14 — root-comment-posted: carries the issueCommentId the frontend
    // could use to deep-link, but the primary consumer only triggers a refetch.
    internal sealed record RootCommentPostedWire(string PrRef, long IssueCommentId);

    // #450 — single-comment-posted: a single inline comment or reply was posted
    // directly (not via a review). Carries the REST reviewCommentId for frontend de-dup.
    internal sealed record SingleCommentPostedWire(string PrRef, long ReviewCommentId);

    // #566 — pr-lifecycle-changed: a PR lifecycle write succeeded (close/reopen/draft toggle).
    // prRef only — the FE reloads PR detail off the signal (mirrors DraftSubmittedWire).
    internal sealed record PrLifecycleChangedWire(string PrRef);

    // #392 — draft-submitted: prRef only. The submit already posted every thread/reply + the
    // PR-root comment server-side, so the frontend just needs the signal to reload PR detail —
    // no review/comment id is carried (threat-model minimal-payload posture).
    internal sealed record DraftSubmittedWire(string PrRef);

    // S6 PR2 — global identity-change event. Minimal payload per spec § 3.2.1: login
    // strings stay server-side (forensic-log surface only); the wire carries just the
    // discriminator so the frontend can route to the right banner / re-validation flow.
    internal sealed record IdentityChangedWire(string Type);

    public static (string EventName, object Payload) Project(IReviewEvent evt) => evt switch
    {
        ActivePrUpdated e => ("pr-updated", new ActivePrUpdatedWire(
            e.PrRef.ToString(), e.NewHeadSha, e.HeadShaChanged, e.CommentCountDelta, e.IsMerged, e.IsClosed,
            e.BaseShaChanged, e.NewBaseSha,
            e.MergeReadiness, e.MergeReadinessChanged, e.Approvals, e.ChangesRequested,
            e.Approvers, e.ChangesRequestedBy, e.AwaitingReviewers)),

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

        RootCommentPostedBusEvent e => ("root-comment-posted", new RootCommentPostedWire(
            e.PrRef.ToString(), e.IssueCommentId)),

        SingleCommentPostedBusEvent e => ("single-comment-posted", new SingleCommentPostedWire(
            e.PrRef.ToString(), e.ReviewCommentId)),

        DraftSubmitted e => ("draft-submitted", new DraftSubmittedWire(e.PrRef.ToString())),

        PrLifecycleChanged e => ("pr-lifecycle-changed", new PrLifecycleChangedWire(e.PrRef.ToString())),

        IdentityChanged _ => ("identity-changed", new IdentityChangedWire("identity-change")),

        _ => throw new ArgumentOutOfRangeException(nameof(evt), $"No SSE projection for {evt.GetType().Name}")
    };
}
