import { apiClient } from './client';
import type { PrReference } from './types';

// POST /api/pr/{ref}/mark-viewed stamps the session's last-viewed-head-sha and
// last-seen-comment-id. Without it, /api/pr/{ref}/submit returns 400
// head-sha-drift on every first-time submit because the backend treats a null
// last-viewed-head-sha as drift (PrSubmitEndpoints.SubmitAsync rule f). The
// hook layer (usePrDetail) fires this once per successful PR-detail fetch.
export interface MarkViewedRequest {
  headSha: string;
  // Highest IssueComment.id rendered on this PR's overview tab, stringified.
  // Null when no root comments exist; the active-PR poll's comment-count delta
  // tracks new comments from a null baseline correctly.
  maxCommentId: string | null;
}

export function postMarkViewed(prRef: PrReference, body: MarkViewedRequest): Promise<void> {
  return apiClient.post<void>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/mark-viewed`,
    body,
  );
}
