import { apiClient, ApiError } from './client';
import { getTabId } from './draft';
import type {
  DraftVerdict,
  PrReference,
  ResumeForeignPendingReviewResponse,
  Verdict,
} from './types';

// 4xx/409 from the submit endpoints carry a `{ code, message }` body. Callers
// (useSubmit → PrHeader toast) branch on `.code` rather than re-parsing the body.
// Codes: stale-drafts / verdict-needs-reconfirm / no-content / head-sha-drift /
// submit-in-progress (409) / unauthorized (401) / no-session / verdict-invalid /
// pending-review-state-changed (TOCTOU, 409) / delete-failed (502).
export class SubmitConflictError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'SubmitConflictError';
    this.code = code;
  }
}

const TAB_ID_HEADER = 'X-PRism-Tab-Id';

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
