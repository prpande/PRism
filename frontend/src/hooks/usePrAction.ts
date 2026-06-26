// frontend/src/hooks/usePrAction.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closePr,
  reopenPr,
  markReady,
  convertToDraft,
  type PrLifecycleErrorCode,
} from '../api/prLifecycle';
import type { PrReference } from '../api/types';
import { useToast } from '../components/Toast/useToast';

export type PrActionKind = 'close' | 'reopen' | 'ready' | 'convert-to-draft';

export interface PrLifecycleState {
  isClosed: boolean;
  isDraft: boolean;
}

export interface UsePrActionArgs {
  prRef: PrReference;
  reload: () => void;
  // The PR's currently-observed lifecycle state. The reconcile fallback is cancelled when this
  // reaches the action's target (close→isClosed, reopen→!isClosed, ready→open+non-draft,
  // convert-to-draft→open+draft) — NOT on a bare object-identity change, which any of the six
  // unrelated reload triggers in PrDetailView would spuriously satisfy. See the plan's
  // reconcile-signal note (round-2 adversarial finding A1).
  prState: PrLifecycleState | undefined;
}

export interface UsePrActionResult {
  pending: PrActionKind | null;
  invoke: (kind: PrActionKind) => void;
}

const FALLBACK_MS = 5000;

const ACTIONS: Record<
  PrActionKind,
  (prRef: PrReference) => Promise<{ ok: boolean; code?: PrLifecycleErrorCode }>
> = {
  close: closePr,
  reopen: reopenPr,
  ready: markReady,
  'convert-to-draft': convertToDraft,
};

// Has the observed PR state reached the target for this action? Used to cancel the SSE-drop
// fallback ONLY on the action's own reconcile (not on any unrelated reload). (Round-2 finding A1.)
function reachedTarget(kind: PrActionKind, s: PrLifecycleState): boolean {
  switch (kind) {
    case 'close':
      return s.isClosed;
    case 'reopen':
      return !s.isClosed;
    case 'ready':
      return !s.isClosed && !s.isDraft;
    case 'convert-to-draft':
      return !s.isClosed && s.isDraft;
  }
}

function copyFor(code: PrLifecycleErrorCode | undefined): string {
  switch (code) {
    case 'token-cannot-write':
      return "PRism can't change this PR's state. Grant PR-write access: classic PAT → the `repo` scope; fine-grained PAT → 'Pull requests: Read and write'. If you're not a collaborator on this repository, lifecycle actions require collaborator access.";
    case 'repo-rule-blocked':
      return 'A repository rule (e.g. branch protection) blocked this action.';
    case 'reopen-not-possible':
      return "This PR can't be reopened — its source branch was deleted.";
    case 'plan-unsupported-drafts':
      return "This repository's plan doesn't support draft pull requests.";
    case 'rate-limited':
      return 'GitHub is rate-limiting requests. Try again shortly.';
    case 'subscribe-rejected':
      return 'This session lost access to the PR. Reload the page.';
    default:
      return 'The action could not be completed. Try again.';
  }
}

export function usePrAction({ prRef, reload, prState }: UsePrActionArgs): UsePrActionResult {
  const [pending, setPending] = useState<PrActionKind | null>(null);
  const inFlight = useRef(false); // synchronous re-entrancy guard (across ALL kinds)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingKindRef = useRef<PrActionKind | null>(null); // the action whose target we await
  // latestState mirrors prState on EVERY render so the POST's .then closure compares against the
  // CURRENT observed state, not the value when invoke ran. This closes the arm-after-reload race:
  // the bus publishes synchronously before the POST's 200 resolves, so a fast SSE reload can flip
  // the state BEFORE .then runs — .then must then NOT arm a doomed timer.
  const latestState = useRef<PrLifecycleState | undefined>(prState);
  latestState.current = prState;
  const { show } = useToast();

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // Cancel the fallback once the observed PR state reaches the pending action's target. An
  // unrelated reload that changes prState WITHOUT reaching the target leaves the timer armed —
  // which is the whole point: the fallback must survive a concurrent comment/draft/re-activation
  // reload and only stand down when THIS action's reconcile actually lands (round-2 finding A1).
  useEffect(() => {
    const kind = pendingKindRef.current;
    if (kind && prState && reachedTarget(kind, prState)) {
      pendingKindRef.current = null;
      clearTimer();
      // Reconcile landed: release the busy state we held through the reconcile window (see
      // invoke). `pending` clearing re-enables the (now refreshed) action set, and inFlight
      // re-opens invoke for the next action.
      setPending(null);
      inFlight.current = false;
    }
    // Intentional: depend on the booleans, not the prState object reference, so an unrelated
    // reload that creates a new prState object without changing the lifecycle booleans does NOT
    // cancel the fallback timer prematurely (round-2 finding A1). `prState` itself is accessed
    // only via the reference-stable booleans already in the dep array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prState?.isClosed, prState?.isDraft, clearTimer]);

  // Tidy the timer on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  const invoke = useCallback(
    (kind: PrActionKind) => {
      if (inFlight.current) return; // ignore double-clicks / a second kind mid-flight
      inFlight.current = true;
      setPending(kind);
      void ACTIONS[kind](prRef)
        .then((r) => {
          if (!r.ok) {
            // Failure: release immediately so the user can retry.
            setPending(null);
            inFlight.current = false;
            show({ kind: 'error', message: copyFor(r.code) });
            return;
          }
          // Success and the reconcile reload already brought the PR to the target state (a fast
          // SSE landed before the POST resolved): release now — done, no fallback needed.
          if (latestState.current && reachedTarget(kind, latestState.current)) {
            setPending(null);
            inFlight.current = false;
            return;
          }
          // Success but the UI hasn't reconciled yet. STAY busy: hold `pending` (so the button
          // remains disabled, showing its in-flight label) and `inFlight` (so invoke is blocked)
          // through the reconcile window. This is the fix for re-clicking an action that already
          // took effect server-side but isn't reflected yet — the user must not be able to fire
          // it again. The prState effect releases when the target is observed; the SSE-drop
          // fallback below bounds the wait to FALLBACK_MS, then reloads AND releases.
          pendingKindRef.current = kind;
          clearTimer();
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            pendingKindRef.current = null;
            setPending(null);
            inFlight.current = false;
            reload();
          }, FALLBACK_MS);
        })
        .catch(() => {
          setPending(null);
          inFlight.current = false;
          show({ kind: 'error', message: copyFor(undefined) });
        });
    },
    [prRef, reload, show, clearTimer],
  );

  return { pending, invoke };
}
