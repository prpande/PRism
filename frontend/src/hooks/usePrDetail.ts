import { useEffect, useRef, useState } from 'react';
import { getPrDetail } from '../api/prDetail';
import { postMarkViewed } from '../api/markViewed';
import type { PrDetailDto, PrReference } from '../api/types';
import { useDelayedLoading } from './useDelayedLoading';

// Highest IssueComment.id across the PR's root conversation, stringified.
// Mirrors the markAllRead patch's HighestIssueCommentId semantics so the
// active-PR poll's comment-count-delta tracks against the same baseline.
function maxRootCommentId(detail: PrDetailDto): string | null {
  if (detail.rootComments.length === 0) return null;
  let maxId = detail.rootComments[0].id;
  for (const c of detail.rootComments) {
    if (c.id > maxId) maxId = c.id;
  }
  return String(maxId);
}

export interface UsePrDetailResult {
  data: PrDetailDto | null;
  isLoading: boolean;
  showSkeleton: boolean;
  error: Error | null;
  reload: () => void;
}

export function usePrDetail(prRef: PrReference): UsePrDetailResult {
  const [data, setData] = useState<PrDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);
  const prevKeyRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Cancellable AbortSignal scoped to this effect run — passed to the
    // fire-and-forget mark-viewed POST so a slow stamp from PR-A can't land
    // after a fast stamp from PR-B once the user navigates between PRs.
    const markViewedAbort = new AbortController();
    // Clear stale data on PR navigation only — React Router reuses this
    // component instance across PR routes, so data from the previous PR would
    // briefly render under the new URL. On reload (same prRef), keep the
    // existing data visible so the page doesn't flash empty UI before the
    // skeleton appears.
    const prKey = `${prRef.owner}/${prRef.repo}/${prRef.number}`;
    if (prevKeyRef.current !== null && prevKeyRef.current !== prKey) {
      setData(null);
    }
    prevKeyRef.current = prKey;
    setIsLoading(true);
    setError(null);
    getPrDetail(prRef)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setIsLoading(false);
        // Best-effort stamp of last-viewed-head-sha + last-seen-comment-id on
        // the backend session. Without this, /api/pr/{ref}/submit returns 400
        // head-sha-not-stamped on every first-time submit (PrSubmitEndpoints
        // rule f, never-stamped branch). Fire-and-forget: a failure (snapshot
        // evicted, transient network) must not block the page from rendering;
        // the next reload re-stamps. The catch logs to console.warn so the
        // failure mode is *visible* in DevTools (a sustained failure would
        // otherwise produce a silent submit→"reload"→submit loop with zero
        // diagnostic signal — the original bug class this PR exists to fix).
        void postMarkViewed(
          prRef,
          {
            headSha: result.pr.headSha,
            maxCommentId: maxRootCommentId(result),
          },
          { signal: markViewedAbort.signal },
        ).catch((e: unknown) => {
          if (e instanceof DOMException && e.name === 'AbortError') return;
          console.warn(
            `[usePrDetail] POST /api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/mark-viewed failed; submit will return head-sha-not-stamped until next reload.`,
            e,
          );
        });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
      markViewedAbort.abort();
    };
  }, [prRef.owner, prRef.repo, prRef.number, reloadCounter]);

  const showSkeleton = useDelayedLoading(isLoading);
  const reload = () => setReloadCounter((c) => c + 1);
  return { data, isLoading, showSkeleton, error, reload };
}
