// frontend/src/hooks/useThreadResolution.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  resolveThread,
  unresolveThread,
  type ThreadResolutionErrorCode,
} from '../api/reviewThread';
import type { PrReference } from '../api/types';

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

// #571 reconcile — RESPONSE-DRIVEN (release on the mutation response), NOT the earlier
// confirm-then-apply that held the busy state until a full PR-detail refetch confirmed the
// isResolved flip. That earlier model made every resolve wait on a slow real-PR refetch and,
// past a 5s fallback, FLASHED a red "couldn't refresh" banner even though the write had
// SUCCEEDED (B1 validation Bug 2). Here the 200 IS the confirmation: we release immediately,
// fire one reload() to pull the new state, and let the effect below drop the collapse override
// when the flip actually lands. A successful write never surfaces an error; only a genuine
// non-2xx (or thrown) response does.
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
  const inFlight = useRef(false);
  const targetRef = useRef<boolean | null>(null); // desired isResolved, armed until the flip lands

  // Drop the busy/announce/in-flight state. Single owner of these three so every code path
  // releases identically. It does NOT touch targetRef — the release effect owns that, clearing it
  // (and the collapse override) only when the reloaded isResolved actually reaches the target.
  const release = useCallback(() => {
    setPending(false);
    setAnnounce(null);
    inFlight.current = false;
  }, []);

  // Once the reloaded isResolved reaches the target, drop the collapse override so isResolved
  // governs the fold again (a manual toggle earlier may have shadowed it). The busy state is
  // already released on the mutation response, so this effect exists only for the override cleanup
  // on the confirmed flip.
  useEffect(() => {
    if (targetRef.current !== null && isResolved === targetRef.current) {
      targetRef.current = null;
      clearCollapseOverride(threadId);
    }
  }, [isResolved, clearCollapseOverride, threadId]);

  const invoke = useCallback(() => {
    if (!prRef || inFlight.current) return; // null prRef = pure-render/read-only; no-op
    inFlight.current = true;
    const target = !isResolved;
    targetRef.current = target;
    setPending(true);
    setError(null); // new attempt clears any prior banner
    setAnnounce(target ? 'Resolving…' : 'Unresolving…');
    const call = target ? resolveThread : unresolveThread;
    void call(prRef, threadId)
      .then((r) => {
        if (!r.ok) {
          targetRef.current = null;
          release();
          setError(copyFor(r.code));
          return;
        }
        // Response-driven reconcile: the 200 confirms the write. Release the busy state now
        // (don't block the UI on a full PR-detail refetch) and reload to pull the new isResolved;
        // the effect above clears the collapse override when the flip lands. No fallback timer and
        // no "couldn't refresh" banner — a successful write never flashes an error (Bug 2 fix).
        setPending(false);
        inFlight.current = false;
        setAnnounce(target ? 'Conversation resolved' : 'Conversation unresolved');
        reload();
      })
      .catch(() => {
        targetRef.current = null;
        release();
        setError(copyFor(undefined));
      });
  }, [prRef, threadId, isResolved, reload, release]);

  return { pending, announce, error, invoke };
}
