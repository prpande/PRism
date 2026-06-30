import type { APIRequestContext } from '@playwright/test';

/**
 * Arms the inbox rehydrated-stale state on the running test server via
 * /test/cold-start-rehydrate. This calls InboxRefreshOrchestrator.ForceRehydrateForTest,
 * which sets a minimal cached snapshot as _current and flips _rehydratedAwaitingRevalidate
 * to true — exactly what InboxCacheRehydrator.StartAsync does at server boot when a valid
 * cache file is present. After this call, GET /api/inbox returns the cached rows immediately
 * with stale:true. The stale flag clears on the next successful RefreshAsync (e.g. triggered
 * by /test/seed-inbox or the natural InboxPoller cadence + SSE event).
 */
export async function seedInboxCache(request: APIRequestContext, baseURL: string): Promise<void> {
  const res = await request.post(`${baseURL}/test/cold-start-rehydrate`, {
    headers: { Origin: baseURL },
  });
  if (!res.ok()) {
    throw new Error(`/test/cold-start-rehydrate failed: ${res.status()} ${await res.text()}`);
  }
}
