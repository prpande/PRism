namespace PRism.Web.Endpoints;

// POST /api/pr/{ref}/submit — body carries only the user's explicit verdict choice from the
// dialog; drafts / replies / summary are read from state.json (spec § 7.1).
internal sealed record SubmitRequestDto(string? Verdict);

// 200 OK shape — the actual progress flows over SSE; this just confirms the pipeline started.
internal sealed record SubmitResponseDto(string Outcome);

// 4xx error shape — { code, message } discriminator (spec § 7.1: stale-drafts / verdict-needs-
// reconfirm / head-sha-drift / no-content / submit-in-progress / unauthorized / no-session /
// verdict-invalid; § 7.2/§ 7.3: pending-review-state-changed). Distinct from the legacy
// PrDraftEndpoints `{ error }` shape — the submit surface standardises on `code`.
internal sealed record SubmitErrorDto(string Code, string Message);

// POST /api/pr/{ref}/submit/foreign-pending-review/{resume|discard} — body identifies which
// pending review the modal was showing (TOCTOU defense re-fetches Snapshot B and rejects if it
// no longer matches).
internal sealed record ForeignPendingReviewActionDto(string? PullRequestReviewId);
