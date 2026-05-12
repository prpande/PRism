using PRism.Core.Contracts;
using PRism.Core.Submit.Pipeline;

namespace PRism.Core.Events;

// Bus events published by the submit endpoint layer (S5 PR3). Each implements the existing
// IReviewEvent marker so IReviewEventBus.Publish<TEvent> accepts it and SseChannel can
// Subscribe<TEvent> + fan it out per-PR via SseEventProjection. The `*BusEvent` suffix
// disambiguates these wire-bound records from the pipeline's internal IProgress payload
// SubmitProgressEvent (PRism.Core.Submit.Pipeline) — they carry the same step/status/counts
// but add the PrReference the per-PR fanout needs.
//
// Threat-model defense (spec § 7.4/§ 7.5/§ 17 #26): payloads are counts + the minimum IDs the
// dialog UX needs and nothing more — no thread/reply bodies, no orphan review id (SubmitStaleCommitOid
// carries only the orphan *commit* oid; SubmitOrphanCleanupFailed carries no id), no PRism-managed
// PendingReviewId. The one review *node* id that ships is SubmitForeignPendingReview.PullRequestReviewId
// — the *foreign* review's id the dialog needs to call /resume and /discard. The per-PR subscription
// is broader-than-spec (any subscribed tab sees the event), so the surface stays minimal.

public sealed record SubmitProgressBusEvent(
    PrReference PrRef,
    SubmitStep Step,
    SubmitStepStatus Status,
    int Done,
    int Total,
    string? ErrorMessage) : IReviewEvent;

public sealed record SubmitForeignPendingReviewBusEvent(
    PrReference PrRef,
    string PullRequestReviewId,
    string CommitOid,
    DateTimeOffset CreatedAt,
    int ThreadCount,
    int ReplyCount) : IReviewEvent;

public sealed record SubmitStaleCommitOidBusEvent(
    PrReference PrRef,
    string OrphanCommitOid) : IReviewEvent;

public sealed record SubmitOrphanCleanupFailedBusEvent(
    PrReference PrRef) : IReviewEvent;

public sealed record SubmitDuplicateMarkerDetectedBusEvent(
    PrReference PrRef,
    string DraftId) : IReviewEvent;
