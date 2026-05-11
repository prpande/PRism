import { useCallback, useRef, useState } from 'react';
import { postReload, type PostReloadResult } from '../api/draft';
import type { PrReference } from '../api/types';

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

  const reload = useCallback(async () => {
    const p = propsRef.current;
    if (p.headSha === null) return;

    setState('reloading');
    setBanner(null);

    const first: PostReloadResult = await postReload(p.prRef, p.headSha);
    if (first.ok) {
      p.onReloadComplete();
      setState('idle');
      return;
    }

    if (first.status === 409 && first.kind === 'reload-in-progress') {
      setBanner(BANNER_IN_PROGRESS);
      setState('error');
      return;
    }

    if (first.status === 409 && first.kind === 'reload-stale-head') {
      const newHead = extractCurrentHeadSha(first.body);
      if (newHead === null) {
        // Backend signaled stale-head but didn't include the new sha.
        // Without a retry sha there's nothing to do — treat as generic.
        setBanner(BANNER_GENERIC);
        setState('error');
        return;
      }
      const second = await postReload(p.prRef, newHead);
      if (second.ok) {
        p.onReloadComplete();
        setState('idle');
        return;
      }
      if (second.status === 409 && second.kind === 'reload-stale-head') {
        setBanner(BANNER_STALE_HEAD);
        setState('error');
        return;
      }
      if (second.status === 409 && second.kind === 'reload-in-progress') {
        setBanner(BANNER_IN_PROGRESS);
        setState('error');
        return;
      }
      setBanner(BANNER_GENERIC);
      setState('error');
      return;
    }

    setBanner(BANNER_GENERIC);
    setState('error');
  }, []);

  const clearBanner = useCallback(() => {
    setBanner(null);
    setState('idle');
  }, []);

  return { state, banner, reload, clearBanner };
}
