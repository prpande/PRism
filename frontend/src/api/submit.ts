import { apiClient, ApiError } from './client';
import { TAB_ID_HEADER, getTabId } from './draft';
import type {
  DraftVerdict,
  PrReference,
  ResumeForeignPendingReviewResponse,
  Verdict,
} from './types';

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

// PUT /draft speaks kebab-case ('request-changes'); POST /submit speaks the
// PascalCase C# enum name. Bridge here so the verdict picker can stay on the
// single canonical DraftVerdict shape everywhere else.
export function verdictToSubmitWire(v: DraftVerdict): Verdict {
  switch (v) {
    case 'approve':
      return 'Approve';
    case 'request-changes':
      return 'RequestChanges';
    case 'comment':
      return 'Comment';
  }
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
  verdict: Verdict,
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

export async function discardAllDrafts(prRef: PrReference): Promise<void> {
  try {
    await apiClient.post<unknown>(`${prPath(prRef)}/drafts/discard-all`, undefined, tabIdHeaders());
  } catch (e) {
    const conflict = asConflict(e);
    if (conflict) throw conflict;
    throw e;
  }
}
