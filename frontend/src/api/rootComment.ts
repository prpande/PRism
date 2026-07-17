import { apiClient, ApiError } from './client';
import { coerceToKnownCode } from './errorCodes';
import type { PrReference } from './types';

// Error codes that POST /api/pr/{ref}/root-comment/post can emit.
// Reconciled against PrRootCommentEndpoints.cs (Task 10):
//   - unauthorized       : 403, not subscribed
//   - submit-in-progress : 409, lock contention with /submit
//   - no-session         : 404, no draft session for this PR
//   - no-root-draft      : 400, no PR-root draft exists
//   - body-too-large     : 400, draft body exceeds GitHub limit
//   - already-posted-body-mismatch : 409, draft was edited after first post
//   - github-forbidden       : 403 via MapGithubError (403 from GitHub; #605 item E)
//   - github-unauthorized    : 401 via MapGithubError (401 from GitHub; #605 item E)
//   - github-validation-error: 502 via MapGithubError (422 from GitHub)
//   - github-not-found       : 404 via MapGithubError (404 from GitHub) — #466
//   - github-network-error   : 502 via MapGithubError fallback + catch-all Exception
//                              (also used as the client-side fallback for non-ApiError throws)
export const KNOWN_POST_ROOT_COMMENT_ERROR_CODES = [
  'unauthorized',
  'submit-in-progress',
  'no-session',
  'no-root-draft',
  'body-too-large',
  'already-posted-body-mismatch',
  'github-forbidden',
  'github-unauthorized',
  'github-validation-error',
  'github-not-found',
  'github-network-error',
] as const;

export type PostRootCommentErrorCode = (typeof KNOWN_POST_ROOT_COMMENT_ERROR_CODES)[number];

export interface PostRootCommentResult {
  ok: true;
}

export interface PostRootCommentError {
  ok: false;
  code: PostRootCommentErrorCode;
  message: string;
  // Only present on already-posted-body-mismatch — the GitHub comment id so the
  // frontend can offer "Edit on github.com" as a resolution path.
  postedCommentId?: number;
}

// POST /api/pr/{owner}/{repo}/{number}/root-comment/post
//
// Posts the PR-root draft comment as a standalone GitHub issue comment without
// submitting a review. Returns { ok: true } on 204 (success or idempotent re-post).
// Returns a discriminated error object for all known error cases rather than throwing,
// so callers can switch on .code without wrapping in try/catch.
export async function postRootComment(
  prRef: PrReference,
): Promise<PostRootCommentResult | PostRootCommentError> {
  try {
    await apiClient.post<unknown>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/root-comment/post`,
      undefined,
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) {
      const body = e.body as { code?: unknown; message?: unknown; postedCommentId?: unknown };
      const code = coerceToKnownCode(
        KNOWN_POST_ROOT_COMMENT_ERROR_CODES,
        body?.code,
        'github-network-error',
      );
      const message = (typeof body?.message === 'string' ? body.message : null) ?? e.message;
      const postedCommentId =
        typeof body?.postedCommentId === 'number' ? body.postedCommentId : undefined;
      return {
        ok: false,
        code,
        message,
        postedCommentId,
      };
    }
    return {
      ok: false,
      code: 'github-network-error',
      message: String(e),
    };
  }
}
