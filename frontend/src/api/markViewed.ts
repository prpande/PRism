import { apiClient } from './client';
import { TAB_ID_HEADER, getTabId } from './draft';
import type { PrReference } from './types';

// POST /api/pr/{ref}/mark-viewed stamps the session's last-viewed-head-sha and
// last-seen-comment-id. Without it, /api/pr/{ref}/submit returns 400
// head-sha-not-stamped on every first-time submit because the backend treats a
// null last-viewed-head-sha as a wire-up gap (PrSubmitEndpoints rule f). The
// hook layer (usePrDetail) fires this once per successful PR-detail fetch.
export interface MarkViewedRequest {
  headSha: string;
  // Highest IssueComment.id rendered on this PR's overview tab, stringified.
  // Null when no root comments exist; the active-PR poll's comment-count delta
  // tracks new comments from a null baseline correctly.
  maxCommentId: string | null;
}

// `signal` lets the caller cancel the POST when its React effect cleans up,
// preventing a slow A-stamp from landing after a fast B-stamp on rapid PR
// navigation. The tab-id header matches every other writer (PUT /draft, POST
// /submit, POST /reload) — the BE doesn't read it on /mark-viewed today, but
// consistency keeps the cross-tab presence signal aligned for future use.
export function postMarkViewed(
  prRef: PrReference,
  body: MarkViewedRequest,
  options?: { signal?: AbortSignal },
): Promise<void> {
  return apiClient.post<void>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/mark-viewed`,
    body,
    {
      headers: { [TAB_ID_HEADER]: getTabId() },
      signal: options?.signal,
    },
  );
}
