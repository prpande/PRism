import { useCallback, useEffect, useRef, useState } from 'react';
import { inboxApi } from '../api/inbox';

const TIMEOUT_MS = 30_000;
const MIN_INTERVAL_MS = 3_000;
const CONFIRM_MS = 3_000; // ≥ MIN_INTERVAL_MS so the lockout window is never feedback-free

interface Options {
  /** Re-fetch the inbox after the backend pull settles. */
  reload: () => Promise<void>;
  /** Surface a soft, dismissible error (the page keeps its current view). */
  onError: (message: string) => void;
}

export interface InboxRefreshState {
  isRefreshing: boolean;
  justRefreshed: boolean;
  announce: string;
  refresh: () => Promise<void>;
}

export function useInboxRefresh({ reload, onError }: Options): InboxRefreshState {
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
    setAnnounce('Refreshing inbox…');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      await inboxApi.refresh(controller.signal);
      await reload();
      lastSuccessAt.current = Date.now(); // stamp ONLY on success
      setAnnounce('Inbox refreshed');
      setJustRefreshed(true);
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      confirmTimer.current = setTimeout(() => setJustRefreshed(false), CONFIRM_MS);
    } catch {
      // Includes the AbortError from a timeout. No min-interval stamp → immediate retry allowed.
      setAnnounce('');
      onError("Couldn't refresh the inbox. Try again.");
    } finally {
      clearTimeout(timer);
      inFlight.current = false;
      setIsRefreshing(false);
    }
  }, [reload, onError]);

  return { isRefreshing, justRefreshed, announce, refresh };
}
