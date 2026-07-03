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

  // Release when the reloaded isResolved reaches the target (confirm-then-apply).
  useEffect(() => {
    if (targetRef.current !== null && isResolved === targetRef.current) {
      targetRef.current = null;
      clearTimer();
      setPending(false);
      setAnnounce(null);
      inFlight.current = false;
      clearCollapseOverride(threadId); // so isResolved governs the fold again
    }
  }, [isResolved, clearTimer, clearCollapseOverride, threadId]);

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
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          setError(copyFor(r.code));
          return;
        }
        // Success — already reconciled (fast SSE)?
        if (latestResolved.current === target) {
          targetRef.current = null;
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          clearCollapseOverride(threadId);
          return;
        }
        // Hold through the reconcile window; fallback bounds the wait.
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          const reconciled = latestResolved.current === targetRef.current;
          targetRef.current = null;
          setPending(false);
          setAnnounce(null);
          inFlight.current = false;
          if (reconciled) {
            clearCollapseOverride(threadId);
          } else {
            reload(); // one more try to refresh
            setReconcileHint(true); // write ok, reload lagging — tell the user (AC7)
          }
        }, FALLBACK_MS);
      })
      .catch(() => {
        targetRef.current = null;
        clearTimer();
        setPending(false);
        setAnnounce(null);
        inFlight.current = false;
        setError(copyFor(undefined));
      });
  }, [prRef, threadId, isResolved, reload, clearCollapseOverride, clearTimer]);

  return { pending, announce, error, reconcileHint, invoke };
}
