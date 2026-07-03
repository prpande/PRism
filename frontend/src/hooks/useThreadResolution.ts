// frontend/src/hooks/useThreadResolution.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveThread,
  unresolveThread,
  type ThreadResolutionErrorCode,
} from '../api/reviewThread';
import type { PrReference } from '../api/types';

const FALLBACK_MS = 5000;

function copyFor(code: ThreadResolutionErrorCode | undefined): string {
  switch (code) {
    case 'token-cannot-write':
      return "PRism can't resolve this conversation. Grant PR-write access: classic PAT → the `repo` scope; fine-grained PAT → 'Pull requests: Read and write'. If you're not a collaborator, this requires collaborator access.";
    case 'subscribe-rejected':
      return 'This session lost access to the PR. Reload the page.';
    case 'thread-not-found':
      return 'This conversation no longer exists on GitHub. Reload the PR.';
    case 'rate-limited':
      return 'GitHub is rate-limiting requests. Try again shortly.';
    default:
      return 'The action could not be completed. Try again.';
  }
}

export function useThreadResolution({
  prRef,
  threadId,
  isResolved,
  reload,
  clearCollapseOverride,
}: {
  prRef: PrReference | null;
  threadId: string;
  isResolved: boolean;
  reload: () => void;
  clearCollapseOverride: (id: string) => void;
}) {
  const [pending, setPending] = useState(false);
  const [announce, setAnnounce] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileHint, setReconcileHint] = useState(false);
  const inFlight = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const targetRef = useRef<boolean | null>(null); // desired isResolved
  const latestResolved = useRef(isResolved);
  latestResolved.current = isResolved;

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Drop the busy/announce/in-flight state. Single owner of these three so every code path
  // releases identically. It intentionally does NOT touch targetRef, error, reconcileHint, or the
  // timer — each caller decides those (e.g. the fallback give-up branch leaves targetRef ARMED so a
  // late reconcile can still land via the release effect).
  const release = useCallback(() => {
    setPending(false);
    setAnnounce(null);
    inFlight.current = false;
  }, []);

  // Release when the reloaded isResolved reaches the target (confirm-then-apply). Also clears
  // reconcileHint: if the fallback gave up (hint=true, targetRef left ARMED) and the reload it
  // fired then lands the correct isResolved a moment later, this effect completes the reconcile —
  // drops the stale "couldn't refresh" banner and restores fold governance to isResolved.
  useEffect(() => {
    if (targetRef.current !== null && isResolved === targetRef.current) {
      targetRef.current = null;
      clearTimer();
      release();
      setReconcileHint(false); // a late reconcile drops the stale give-up hint
      clearCollapseOverride(threadId); // so isResolved governs the fold again
    }
  }, [isResolved, clearTimer, release, clearCollapseOverride, threadId]);

  useEffect(() => clearTimer, [clearTimer]);

  const invoke = useCallback(() => {
    if (!prRef || inFlight.current) return; // null prRef = pure-render/read-only; no-op
    inFlight.current = true;
    const target = !isResolved;
    targetRef.current = target;
    setPending(true);
    setError(null); // new attempt clears any prior banner
    setReconcileHint(false);
    setAnnounce(target ? 'Resolving…' : 'Unresolving…');
    const call = target ? resolveThread : unresolveThread;
    void call(prRef, threadId)
      .then((r) => {
        if (!r.ok) {
          targetRef.current = null;
          clearTimer();
          release();
          setError(copyFor(r.code));
          return;
        }
        // Success — already reconciled (fast SSE)? If targetRef is already null the release effect
        // beat us to it (an external isResolved flip fired first) — it already called
        // clearCollapseOverride, so bail before calling it a second time.
        if (latestResolved.current === target) {
          if (targetRef.current === null) return; // effect already reconciled this
          targetRef.current = null;
          release();
          clearCollapseOverride(threadId);
          return;
        }
        // Hold through the reconcile window; fallback bounds the wait.
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const reconciled = latestResolved.current === targetRef.current;
          if (reconciled) {
            targetRef.current = null;
            release();
            clearCollapseOverride(threadId);
          } else {
            // Give up waiting, but leave targetRef ARMED: if the reload below (or any later
            // isResolved flip) lands the target, the release effect still completes the reconcile
            // and clears reconcileHint. Nulling targetRef here would forfeit that recovery.
            release();
            reload(); // one more try to refresh
            setReconcileHint(true); // write ok, reload lagging — tell the user (AC7)
          }
        }, FALLBACK_MS);
      })
      .catch(() => {
        targetRef.current = null;
        clearTimer();
        release();
        setError(copyFor(undefined));
      });
  }, [prRef, threadId, isResolved, reload, clearCollapseOverride, clearTimer, release]);

  return { pending, announce, error, reconcileHint, invoke };
}
