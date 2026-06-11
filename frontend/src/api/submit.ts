import { apiClient, ApiError } from './client';
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
//   - unauthorized              : 401, not subscribed
//   - pipeline-cancellation-timeout : 504, pipeline held lock beyond 30-second window
//   - github-forbidden          : 502 via MapGithubError (403 from GitHub)
//   - github-unauthorized       : 502 via MapGithubError (401 from GitHub)
//   - github-validation-error   : 502 via MapGithubError (422 from GitHub)
//   - github-network-error      : 502 via MapGithubError fallback + catch-all Exception
//                                 (also used as the client-side fallback for non-ApiError throws)
export type DiscardOwnPendingReviewErrorCode =
  | 'unauthorized'
  | 'pipeline-cancellation-timeout'
  | 'github-forbidden'
  | 'github-unauthorized'
  | 'github-validation-error'
  | 'github-network-error';

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
      const code = (typeof body?.code === 'string' ? body.code : null) ?? 'github-network-error';
      const message = (typeof body?.message === 'string' ? body.message : null) ?? e.message;
      return {
        ok: false,
        code: code as DiscardOwnPendingReviewErrorCode,
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
