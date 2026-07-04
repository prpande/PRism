import { apiClient, ApiError } from './client';
import type { PrReference } from './types';

export type ThreadResolutionErrorCode =
  | 'token-cannot-write'
  | 'thread-not-found'
  | 'rate-limited'
  | 'subscribe-rejected'
  | 'generic';

export interface ThreadActionResult {
  ok: boolean;
  code?: ThreadResolutionErrorCode;
}

const KNOWN: ReadonlySet<string> = new Set([
  'token-cannot-write',
  'thread-not-found',
  'rate-limited',
]);

// ApiError is { status, requestId, body } — there is NO `.code` field.
// The endpoint returns the kebab code inside the JSON body ({ code }), so read e.body.code.
// RequireSubscribed rejects with HTTP 403 + code "unauthorized" (shared with
// token-cannot-write), so disambiguate by CODE, not status.
function handleThreadError(e: unknown): ThreadActionResult {
  if (e instanceof ApiError) {
    const raw = (e.body as { code?: string } | null | undefined)?.code;
    if (raw === 'unauthorized') return { ok: false, code: 'subscribe-rejected' };
    return {
      ok: false,
      code: raw && KNOWN.has(raw) ? (raw as ThreadResolutionErrorCode) : 'generic',
    };
  }
  return { ok: false, code: 'generic' };
}

async function run(
  prRef: PrReference,
  action: 'resolve' | 'unresolve',
  threadId: string,
): Promise<ThreadActionResult> {
  try {
    // apiClient.post attaches X-PRism-Tab-Id on every request (api/client.ts).
    await apiClient.post(`/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/thread/${action}`, {
      threadId,
    });
    return { ok: true };
  } catch (e) {
    return handleThreadError(e);
  }
}

export const resolveThread = (prRef: PrReference, threadId: string) =>
  run(prRef, 'resolve', threadId);
export const unresolveThread = (prRef: PrReference, threadId: string) =>
  run(prRef, 'unresolve', threadId);
