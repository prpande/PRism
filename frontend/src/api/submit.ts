import { apiClient, ApiError } from './client';
import { coerceToKnownCode } from './errorCodes';
import { TAB_ID_HEADER, getTabId } from './draft';
import type { DraftVerdict, PrReference, ResumeForeignPendingReviewResponse } from './types';

// Known SubmitErrorDto.code values from PRism.Web/Endpoints. Kept in sync with
// PrSubmitEndpoints.cs's pre-pipeline rejections + the foreign-pending-review
// resume/discard 409s. Server may send a code outside this set during a
// schema-bump window — `SubmitConflictError.code` keeps the looser `string`
// type so that case round-trips cleanly; PrHeader's switch narrows via
// isKnownSubmitErrorCode and falls through to the server message when narrow
// fails (so an unrecognised code is visible, not silent).
export const KNOWN_SUBMIT_ERROR_CODES = [
  'stale-drafts',
  'verdict-needs-reconfirm',
  'no-content',
  'head-sha-drift',
  'head-sha-not-stamped',
  // Cross-tab-stamp slice — distinct 422 when the request carries no X-PRism-Tab-Id (or an
  // out-of-allowlist value). The toast remediation is "reload this tab" rather than the
  // head-sha-not-stamped "reload the PR detail" remedy.
  'tab-id-missing',
  'submit-in-progress',
  'unauthorized',
  'no-session',
  'verdict-invalid',
  'pending-review-state-changed',
  'delete-failed',
] as const;

export type KnownSubmitErrorCode = (typeof KNOWN_SUBMIT_ERROR_CODES)[number];

export function isKnownSubmitErrorCode(code: string): code is KnownSubmitErrorCode {
  return (KNOWN_SUBMIT_ERROR_CODES as readonly string[]).includes(code);
}

// 4xx/409 from the submit endpoints carry a `{ code, message }` body. Callers
// (useSubmit → PrHeader toast) branch on `.code` rather than re-parsing the body.
// `code` stays typed as `string` rather than `KnownSubmitErrorCode` so an
// unknown future code from the server doesn't crash construction; downstream
// switch logic narrows via `isKnownSubmitErrorCode` to get exhaustiveness.
export class SubmitConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SubmitConflictError';
    this.code = code;
  }
}

// Maps backend SubmitErrorDto.code values to user-facing toast copy. Keep in
// sync with PrSubmitEndpoints.cs (the SubmitAsync rule a–f rejections + the
// submit-in-progress 409). An unknown code (forward-compat: server schema
// bump arriving before the FE knows about it) falls through to the
// server-supplied message so it's still visible, not silent. A *known* code
// missing from the switch is a compile-time error (TS2366): no `default`
// clause + the explicit `: string` return type make the function's ending
// reachable under strictNullChecks. (Verified: deleting a case fails tsc -b.)
// The parity guard in submit.test.ts additionally pins the per-code copy.
// Regression: prior to this map, the catch was empty with a comment claiming
// useSubmitToasts handled it — that hook only listens for two SSE events,
// not HTTP 4xx, which made every pre-pipeline rejection invisible.
export function submitErrorMessage(err: SubmitConflictError): string {
  if (!isKnownSubmitErrorCode(err.code)) return err.message;
  const code: KnownSubmitErrorCode = err.code;
  switch (code) {
    case 'head-sha-not-stamped':
      return "Couldn't submit — the PR view hasn't been stamped yet. Reload the PR and try again.";
    case 'tab-id-missing':
      // Cross-tab-stamp slice: the server got no X-PRism-Tab-Id header (or one outside the
      // allowlist). The remedy is to reload THIS tab so getTabId() mints a fresh id and the
      // first /mark-viewed call stamps it. "Reload the PR" (the head-sha-not-stamped wording
      // above) would point the user at the wrong remediation — the PR detail isn't stale,
      // the tab itself is.
      return "Couldn't submit — this browser tab is in an unexpected state. Reload the tab and try again.";
    case 'head-sha-drift':
      return "Couldn't submit — the PR's head commit changed since you last viewed it. Reload the PR.";
    case 'unauthorized':
      return "Couldn't submit — your subscription to this PR was lost. Reload the PR.";
    case 'no-session':
      return "Couldn't submit — no draft session for this PR. Reload the PR.";
    case 'stale-drafts':
      return "Couldn't submit — there are stale drafts. Resolve or override them in the Drafts tab first.";
    case 'verdict-needs-reconfirm':
      return "Couldn't submit — re-confirm your verdict before submitting.";
    case 'no-content':
      return "Couldn't submit — a Comment-verdict review needs at least one inline comment, reply, or summary.";
    case 'verdict-invalid':
      return "Couldn't submit — verdict must be Approve, Request changes, or Comment.";
    case 'submit-in-progress':
      return 'A submit is already in flight for this PR. Wait for it to finish or refresh the page.';
    case 'pending-review-state-changed':
      // Normally handled by surfaceForeignReviewError on the Resume/Discard
      // path. If a submit ever surfaces it (race between submit and a peer
      // changing pending-review state), fall back to the server message.
      return err.message;
    case 'delete-failed':
      // 502 from cleanup of the foreign pending review on discardAll —
      // user-visible copy lives in onDiscardAllDrafts; if it ever flows here,
      // honour the server message.
      return err.message;
  }
}

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

function tabIdHeaders(): { headers: Record<string, string> } {
  return { headers: { [TAB_ID_HEADER]: getTabId() } };
}

function asConflict(e: unknown): SubmitConflictError | null {
  if (!(e instanceof ApiError)) return null;
  const body = e.body;
  if (typeof body === 'object' && body !== null && 'code' in body) {
    const code = (body as { code?: unknown }).code;
    const msg = (body as { message?: unknown }).message;
    if (typeof code === 'string') {
      return new SubmitConflictError(code, typeof msg === 'string' ? msg : `HTTP ${e.status}`);
    }
  }
  return null;
}

export async function submitReview(
  prRef: PrReference,
  verdict: DraftVerdict,
): Promise<{ outcome: 'started' }> {
  try {
    return await apiClient.post<{ outcome: 'started' }>(
      `${prPath(prRef)}/submit`,
      { verdict },
      tabIdHeaders(),
    );
  } catch (e) {
    const conflict = asConflict(e);
    if (conflict) throw conflict;
    throw e;
  }
}

export async function resumeForeignPendingReview(
  prRef: PrReference,
  pullRequestReviewId: string,
): Promise<ResumeForeignPendingReviewResponse> {
  try {
    return await apiClient.post<ResumeForeignPendingReviewResponse>(
      `${prPath(prRef)}/submit/foreign-pending-review/resume`,
      { pullRequestReviewId },
      tabIdHeaders(),
    );
  } catch (e) {
    const conflict = asConflict(e);
    if (conflict) throw conflict;
    throw e;
  }
}

export async function discardForeignPendingReview(
  prRef: PrReference,
  pullRequestReviewId: string,
): Promise<void> {
  try {
    await apiClient.post<unknown>(
      `${prPath(prRef)}/submit/foreign-pending-review/discard`,
      { pullRequestReviewId },
      tabIdHeaders(),
    );
  } catch (e) {
    const conflict = asConflict(e);
    if (conflict) throw conflict;
    throw e;
  }
}

// Error codes that POST /api/pr/{ref}/submit/discard (DiscardOwnPendingReviewAsync) can emit.
// Reconciled against PrSubmitEndpoints.cs (Task 11):
//   - unauthorized              : 403, not subscribed
//   - pipeline-cancellation-timeout : 504, pipeline held lock beyond 30-second window
//   - github-forbidden          : 502 via MapGithubError (403 from GitHub)
//   - github-unauthorized       : 502 via MapGithubError (401 from GitHub)
//   - github-validation-error   : 502 via MapGithubError (422 from GitHub)
//   - github-network-error      : 502 via MapGithubError fallback + catch-all Exception
//                                 (also used as the client-side fallback for non-ApiError throws)
// #466 — 'github-not-found' is deliberately NOT listed: both GitHub calls in
// DiscardOwnPendingReviewAsync (find + delete) are GraphQL, whose not-found surfaces
// as GitHubGraphQLException / null data → network-error, never HttpRequestException(404)
// (the endpoint's NotFound catch fires only on a transport-level 404, which the GraphQL
// endpoint doesn't produce in practice). No live trigger here; coerceToKnownCode would
// fall an unexpected occurrence back to github-network-error with the server message
// still surfaced.
export const KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES = [
  'unauthorized',
  'pipeline-cancellation-timeout',
  'github-forbidden',
  'github-unauthorized',
  'github-validation-error',
  'github-network-error',
] as const;

export type DiscardOwnPendingReviewErrorCode =
  (typeof KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES)[number];

export interface DiscardOwnPendingReviewResult {
  ok: true;
}

export interface DiscardOwnPendingReviewError {
  ok: false;
  code: DiscardOwnPendingReviewErrorCode;
  message: string;
}

// POST /api/pr/{owner}/{repo}/{number}/submit/discard
//
// Signals cancellation to any in-flight submit pipeline for this PR, waits for
// the lock to be released (up to 30 s), then deletes the own pending review on
// GitHub and clears local pending-review stamps. Returns { ok: true } on 204
// (success). Returns a discriminated error object for all known error cases
// rather than throwing, so callers can switch on .code without try/catch.
export async function discardOwnPendingReview(
  prRef: PrReference,
): Promise<DiscardOwnPendingReviewResult | DiscardOwnPendingReviewError> {
  try {
    await apiClient.post<unknown>(`${prPath(prRef)}/submit/discard`, undefined);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { code?: unknown; message?: unknown };
      const code = coerceToKnownCode(
        KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES,
        body?.code,
        'github-network-error',
      );
      const message = (typeof body?.message === 'string' ? body.message : null) ?? e.message;
      return {
        ok: false,
        code,
        message,
      };
    }
    return {
      ok: false,
      code: 'github-network-error',
      message: String(e),
    };
  }
}

export async function discardAllDrafts(prRef: PrReference): Promise<void> {
  try {
    await apiClient.post<unknown>(`${prPath(prRef)}/drafts/discard-all`, undefined, tabIdHeaders());
  } catch (e) {
    const conflict = asConflict(e);
    if (conflict) throw conflict;
    throw e;
  }
}
