import { apiClient, ApiError } from './client';
import type { PrReference } from './types';

export type PrLifecycleErrorCode =
  | 'token-cannot-write'
  | 'repo-rule-blocked'
  | 'reopen-not-possible'
  | 'plan-unsupported-drafts'
  | 'rate-limited'
  | 'merge-not-mergeable'
  | 'merge-head-changed'
  | 'subscribe-rejected'
  | 'generic';

export type MergeMethodWire = 'merge' | 'squash' | 'rebase';

export interface PrActionResult {
  ok: boolean;
  code?: PrLifecycleErrorCode;
}

const KNOWN: ReadonlySet<string> = new Set([
  'token-cannot-write',
  'repo-rule-blocked',
  'reopen-not-possible',
  'plan-unsupported-drafts',
  'rate-limited',
  'merge-not-mergeable',
  'merge-head-changed',
]);

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

async function run(prRef: PrReference, action: string): Promise<PrActionResult> {
  try {
    // apiClient.post attaches X-PRism-Tab-Id on every request (api/client.ts).
    await apiClient.post(`${prPath(prRef)}/${action}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      // ApiError is { status, requestId, body } — there is NO `.code` field.
      // The endpoint returns the kebab code inside the JSON body ({ code }), so read e.body.code.
      const raw = (e.body as { code?: string } | null | undefined)?.code;
      // RequireSubscribed rejects with HTTP 403 + code "unauthorized" (NOT 401 — client.ts
      // pre-empts any real 401 with a global prism-auth-rejected dispatch before throwing). 403
      // is shared with token-cannot-write, so disambiguate by CODE, not status.
      if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
      const code = raw && KNOWN.has(raw) ? (raw as PrLifecycleErrorCode) : 'generic';
      return { ok: false, code };
    }
    return { ok: false, code: 'generic' };
  }
}

export const closePr = (prRef: PrReference) => run(prRef, 'close');
export const reopenPr = (prRef: PrReference) => run(prRef, 'reopen');
export const markReady = (prRef: PrReference) => run(prRef, 'ready-for-review');
export const convertToDraft = (prRef: PrReference) => run(prRef, 'convert-to-draft');

export async function mergePr(
  prRef: PrReference,
  method: MergeMethodWire,
  headSha: string,
): Promise<PrActionResult> {
  try {
    await apiClient.post(`${prPath(prRef)}/merge`, { method, headSha });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const raw = (e.body as { code?: string } | null | undefined)?.code;
      if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
      const code = raw && KNOWN.has(raw) ? (raw as PrLifecycleErrorCode) : 'generic';
      return { ok: false, code };
    }
    return { ok: false, code: 'generic' };
  }
}
