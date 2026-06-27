// frontend/src/hooks/usePrAction.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  closePr,
  reopenPr,
  markReady,
  convertToDraft,
  mergePr,
  type PrLifecycleErrorCode,
  type MergeMethodWire,
} from '../api/prLifecycle';
import type { PrReference } from '../api/types';
import { useToast } from '../components/Toast/useToast';

export type PrActionKind = 'close' | 'reopen' | 'ready' | 'convert-to-draft' | 'merge';
export type MergePhase = 'idle' | 'merging' | 'checking';

export interface PrLifecycleState {
  isClosed: boolean;
  isDraft: boolean;
  isMerged: boolean;
}

export interface MergePayload {
  method: MergeMethodWire;
  headSha: string;
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
  mergePhase: MergePhase;
  invoke: (kind: PrActionKind, payload?: MergePayload) => void;
}

const FALLBACK_MS = 5000;
const MERGE_RECONCILE_MS = 10_000; // commit-creation + GraphQL read-after-write; one window for all merge paths

// merge is excluded: it has its own POST signature (method + headSha) and orchestration; the
// four state flips share the parameterless run() shape.
const ACTIONS: Record<
  Exclude<PrActionKind, 'merge'>,
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
    case 'merge':
      return s.isMerged;
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
    case 'merge-head-changed':
      return 'The PR changed since you loaded it — re-arm to retry with the latest.';
    case 'merge-not-mergeable':
      return "This PR can't be merged right now (checks, protection, or method changed).";
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

  // ── merge state (slice 2) ─────────────────────────────────────────────────────────────────
  const [mergePhase, setMergePhase] = useState<MergePhase>('idle');
  const staleHeadShaRef = useRef<string | null>(null); // a headSha that 409'd; block re-merge until it changes

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
      // Merge reconcile landed too: drop the phase so a later MERGE_RECONCILE_MS fire
      // can't surface a stale "still processing"/error toast.
      setMergePhase('idle');
    }
    // Intentional: depend on the booleans, not the prState object reference, so an unrelated
    // reload that creates a new prState object without changing the lifecycle booleans does NOT
    // cancel the fallback timer prematurely (round-2 finding A1). `prState` itself is accessed
    // only via the reference-stable booleans already in the dep array. isMerged is load-bearing:
    // a merge flips ONLY isMerged (isClosed/isDraft unchanged), so without it the effect never
    // re-runs to release pending='merge' — the 10s timer would (wrongly) be the only release.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prState?.isClosed, prState?.isDraft, prState?.isMerged, clearTimer]);

  // Tidy the timer on unmount.
  useEffect(() => clearTimer, [clearTimer]);

  // ── merge orchestration (slice 2) ─────────────────────────────────────────────────────────
  // Arm a reconcile hold for merge: keep pending='merge' until isMerged is observed, bounded by
  // MERGE_RECONCILE_MS. onTimeout decides what the bound does: 'reload-silent' (happy fallback —
  // reload + show the still-finishing snackbar) or 'toast-not-mergeable' (405/422 reconcile lost).
  const armMergeHold = useCallback(
    (onTimeout: 'reload-silent' | 'toast-not-mergeable') => {
      pendingKindRef.current = 'merge';
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        pendingKindRef.current = null;
        setPending(null);
        setMergePhase('idle');
        inFlight.current = false;
        if (onTimeout === 'toast-not-mergeable') {
          show({ kind: 'error', message: copyFor('merge-not-mergeable') });
        } else {
          reload();
          show({
            kind: 'info',
            message: 'The merge may still be processing — refresh if the status doesn’t update.',
          });
        }
      }, MERGE_RECONCILE_MS);
    },
    [clearTimer, reload, show],
  );

  const invokeMerge = useCallback(
    (payload?: MergePayload) => {
      if (!payload) return;
      // Stale-sha gate: after a 409, refuse to re-merge the same headSha until a reload changed it.
      if (staleHeadShaRef.current && staleHeadShaRef.current === payload.headSha) {
        show({ kind: 'error', message: 'Could not refresh the PR — try again.' });
        return;
      }
      inFlight.current = true;
      setPending('merge');
      setMergePhase('merging');
      void mergePr(prRef, payload.method, payload.headSha)
        .then((r) => {
          if (r.ok) {
            staleHeadShaRef.current = null;
            if (latestState.current && reachedTarget('merge', latestState.current)) {
              setPending(null);
              setMergePhase('idle');
              inFlight.current = false;
              return;
            }
            armMergeHold('reload-silent'); // hold; fallback reloads + still-finishing snackbar
            return;
          }
          if (r.code === 'merge-head-changed') {
            staleHeadShaRef.current = payload.headSha; // block re-merge until headSha changes
            setPending(null);
            setMergePhase('idle');
            inFlight.current = false;
            reload();
            show({ kind: 'error', message: copyFor('merge-head-changed') });
            return;
          }
          if (r.code === 'merge-not-mergeable') {
            setMergePhase('checking'); // neutral "Checking…" while we reload + re-check isMerged
            reload();
            if (latestState.current && reachedTarget('merge', latestState.current)) {
              setPending(null);
              setMergePhase('idle');
              inFlight.current = false;
              return; // already merged
            }
            armMergeHold('toast-not-mergeable'); // success if isMerged flips; else toast on timeout
            return;
          }
          // other codes: immediate release + toast
          setPending(null);
          setMergePhase('idle');
          inFlight.current = false;
          show({ kind: 'error', message: copyFor(r.code) });
        })
        .catch(() => {
          setPending(null);
          setMergePhase('idle');
          inFlight.current = false;
          show({ kind: 'error', message: copyFor(undefined) });
        });
    },
    [prRef, reload, show, armMergeHold],
  );

  const invoke = useCallback(
    (kind: PrActionKind, payload?: MergePayload) => {
      if (inFlight.current) return; // ignore double-clicks / a second kind mid-flight
      if (kind === 'merge') {
        invokeMerge(payload);
        return;
      }
      inFlight.current = true;
      setPending(kind);
      void ACTIONS[kind as Exclude<PrActionKind, 'merge'>](prRef)
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
    [prRef, reload, show, clearTimer, invokeMerge],
  );

  return { pending, mergePhase, invoke };
}
