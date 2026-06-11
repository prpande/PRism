import { useCallback, useEffect, useRef, useState } from 'react';
import { refreshPrDetail } from '../api/prDetail';
import type { PrReference } from '../api/types';

const TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 3_000;
const CONFIRM_MS = 3_000; // ≥ MIN_INTERVAL_MS so the lockout window is never feedback-free

interface Options {
  prRef: PrReference;
  /** Re-fetch the PR detail. usePrDetail.reload is a void counter bump (fire-and-forget), NOT awaitable. */
  reload: () => void;
  /** Clear any latched "update available" banner — a manual pull moots it (wraps updates.clear). */
  clearUpdates: () => void;
  /** Surface a soft, dismissible error (the view keeps its current data). */
  onError: (message: string) => void;
}

export interface PrDetailRefreshState {
  isRefreshing: boolean;
  justRefreshed: boolean;
  announce: string;
  refresh: () => Promise<void>;
}

export function usePrDetailRefresh({
  prRef,
  reload,
  clearUpdates,
  onError,
}: Options): PrDetailRefreshState {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [justRefreshed, setJustRefreshed] = useState(false);
  const [announce, setAnnounce] = useState('');
  const inFlight = useRef(false);
  const lastSuccessAt = useRef(0);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
    },
    [],
  );

  const refresh = useCallback(async () => {
    // Re-entrancy guard (synchronous — state updates are async) + min-interval-after-SUCCESS.
    if (inFlight.current) return;
    if (Date.now() - lastSuccessAt.current < MIN_INTERVAL_MS) return;

    inFlight.current = true;
    setIsRefreshing(true);
    setAnnounce('Refreshing PR…');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await refreshPrDetail(prRef, controller.signal); // the awaited step — backend now fresh
      reload(); // fire-and-forget re-GET (usePrDetail.reload is void, not awaitable)
      clearUpdates(); // dismiss any latched "update available" banner
      lastSuccessAt.current = Date.now(); // stamp ONLY on success
      setAnnounce('PR refreshed');
      setJustRefreshed(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setJustRefreshed(false), CONFIRM_MS);
    } catch {
      // Includes the AbortError from a timeout. No min-interval stamp → immediate retry allowed.
      setAnnounce('');
      onError("Couldn't refresh this PR. Try again.");
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setIsRefreshing(false);
    }
  }, [prRef, reload, clearUpdates, onError]);

  return { isRefreshing, justRefreshed, announce, refresh };
}
