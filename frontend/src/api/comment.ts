import type { PrReference } from './types';
import { apiClient, ApiError } from './client';

function prPath(prRef: PrReference): string {
  return `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`;
}

export type PostCommentResult =
  | { ok: true; postedCommentId: number }
  | { ok: false; status: number; code: string; message: string; postedCommentId?: number };

// Single endpoint; the backend discriminates inline vs reply by draft kind.
export async function postComment(
  prRef: PrReference,
  draftId: string,
): Promise<PostCommentResult> {
  try {
    const res = await apiClient.post<{ postedCommentId: number }>(
      `${prPath(prRef)}/comment/post`,
      { draftId },
      {},
    );
    return { ok: true, postedCommentId: res.postedCommentId };
  } catch (e) {
    if (e instanceof ApiError) {
      const payload = (e.body ?? {}) as {
        code?: string;
        message?: string;
        postedCommentId?: number;
      };
      return {
        ok: false,
        status: e.status,
        code: payload.code ?? 'unknown',
        message: payload.message ?? 'Failed to post the comment.',
        ...(payload.postedCommentId !== undefined
          ? { postedCommentId: payload.postedCommentId }
          : {}),
      };
    }
    return { ok: false, status: 0, code: 'network', message: 'Network error.' };
  }
}
