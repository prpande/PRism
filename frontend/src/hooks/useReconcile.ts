import { useCallback, useEffect, useRef, useState } from 'react';
import { postReload, type PostReloadResult } from '../api/draft';
import type { PrReference } from '../api/types';

// Mirrors usePrDetailRefresh: a hung reload fetch must not leave the UI stuck in
// 'reloading' forever — abort it after this window and surface the generic banner.
const TIMEOUT_MS = 30_000;

// Spec § 3.3 + plan Task 46. Wraps POST /api/pr/{ref}/reload with the spec's
// head-shift auto-retry policy:
//   - 409 reload-stale-head → retry once with the currentHeadSha returned in
//     the body. A second 409 stale-head means the head shifted again during
//     the in-flight retry; surface the banner and stop.
//   - 409 reload-in-progress → another reload is mid-flight; do not retry,
//     just surface the banner.
//   - Network / 5xx / other → leave the user with a generic banner that
//     they can clear and try again.

export type UseReconcileState = 'idle' | 'reloading' | 'error';

export interface UseReconcileProps {
  prRef: PrReference;
  // Current head sha known to the active-PR poller. `null` when the poller
  // has not yet returned a snapshot — reload silently no-ops in that case
  // (the UI button is also disabled upstream, but the guard here keeps the
  // hook safe to call from any caller).
  headSha: string | null;
  // Called once on a successful reload (initial call OR auto-retry). Caller
  // typically wires this to `useDraftSession.refetch()` since the reload
  // backend already returns the new session DTO, but the own-tab is
  // filtered out of the StateChanged SSE channel and must refetch
  // explicitly.
  onReloadComplete: () => void;
}

export interface UseReconcileResult {
  state: UseReconcileState;
  banner: string | null;
  reload: () => Promise<void>;
  clearBanner: () => void;
}

const BANNER_STALE_HEAD = 'Head shifted while reloading; please click Reload again.';
const BANNER_IN_PROGRESS = 'Reload already in progress; please wait.';
const BANNER_GENERIC = "Couldn't reload — please try again.";

function extractCurrentHeadSha(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const candidate = (body as { currentHeadSha?: unknown }).currentHeadSha;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

export function useReconcile({
  prRef,
  headSha,
  onReloadComplete,
}: UseReconcileProps): UseReconcileResult {
  const [state, setState] = useState<UseReconcileState>('idle');
  const [banner, setBanner] = useState<string | null>(null);

  // Latest values mirrored into refs so the `reload` callback never
  // captures stale props after a re-render.
  const propsRef = useRef({ prRef, headSha, onReloadComplete });
  propsRef.current = { prRef, headSha, onReloadComplete };

  // Re-entrancy guard (synchronous — state updates are async): a second click
  // while a reload is in flight is a no-op, so the later resolver can't clobber
  // the earlier one's result.
  const inFlight = useRef(false);
  // Mounted guard: a reload that resolves after the view tore down must not
  // setState (React warning) or fire onReloadComplete against a dead view.
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  const reload = useCallback(async () => {
    const p = propsRef.current;
    if (p.headSha === null) return;
    if (inFlight.current) return;
    // Capture into a local so the property narrowing survives the nested async
    // closure below (TS resets property narrowing across function boundaries).
    const headSha = p.headSha;

    inFlight.current = true;
    setState('reloading');
    setBanner(null);

    // One AbortController + timeout spans the initial POST and the stale-head
    // auto-retry. postReload maps an abort to its no-throw `network` result, so
    // a timed-out (hung) fetch lands on the generic banner instead of stuck
    // 'reloading'.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    type Outcome = { complete: boolean; banner: string | null; state: UseReconcileState };
    const outcome: Outcome = await (async (): Promise<Outcome> => {
      const first: PostReloadResult = await postReload(p.prRef, headSha, controller.signal);
      if (first.ok) return { complete: true, banner: null, state: 'idle' };

      if (first.status === 409 && first.kind === 'reload-in-progress') {
        return { complete: false, banner: BANNER_IN_PROGRESS, state: 'error' };
      }

      if (first.status === 409 && first.kind === 'reload-stale-head') {
        const newHead = extractCurrentHeadSha(first.body);
        // Backend signaled stale-head but didn't include the new sha. Without a
        // retry sha there's nothing to do — treat as generic.
        if (newHead === null) return { complete: false, banner: BANNER_GENERIC, state: 'error' };
        const second = await postReload(p.prRef, newHead, controller.signal);
        if (second.ok) return { complete: true, banner: null, state: 'idle' };
        if (second.status === 409 && second.kind === 'reload-stale-head') {
          return { complete: false, banner: BANNER_STALE_HEAD, state: 'error' };
        }
        if (second.status === 409 && second.kind === 'reload-in-progress') {
          return { complete: false, banner: BANNER_IN_PROGRESS, state: 'error' };
        }
        return { complete: false, banner: BANNER_GENERIC, state: 'error' };
      }

      return { complete: false, banner: BANNER_GENERIC, state: 'error' };
    })().finally(() => {
      clearTimeout(timer);
    });

    // Gate every observable effect on the view still being mounted. Hold the
    // re-entrancy guard until the terminal outcome has actually been applied
    // (or the view unmounted): clearing it inside the IIFE's .finally() above
    // would open a microtask gap where inFlight is false but the outcome is
    // not yet applied, letting a second rapid click start a duplicate POST.
    if (!mounted.current) {
      inFlight.current = false;
      return;
    }
    if (outcome.complete) p.onReloadComplete();
    setBanner(outcome.banner);
    setState(outcome.state);
    inFlight.current = false;
  }, []);

  const clearBanner = useCallback(() => {
    setBanner(null);
    setState('idle');
  }, []);

  return { state, banner, reload, clearBanner };
}
