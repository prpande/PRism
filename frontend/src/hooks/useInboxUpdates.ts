import { useCallback, useEffect, useRef, useState } from 'react';
import { useEventSource } from './useEventSource';

const DEBOUNCE_MS = 500;

interface Options {
  /** Re-fetch the inbox. Awaited so the trailing-queue knows when a reload finishes. */
  onUpdate: () => Promise<void>;
}

// #450 — auto-refresh on inbox-updated, replacing the manual reload banner.
// - Trailing debounce coalesces a burst (one inbox-updated frame per changed PR) into one GET.
// - In-flight coalescing QUEUES exactly one trailing reload (never "skip", which would drop the
//   last update). useInbox.reload already has a generation guard for setData races, so this guard
//   exists only for trailing-coalescing correctness (spec §3.2).
// - `announce` gives screen-reader users the signal the removed banner (role=status) carried.
const ANNOUNCE_TEXT = 'Inbox updated';
// A polite live region only re-announces when its text node changes. Every auto-refresh
// announces the same words, so we alternate a trailing zero-width space (#450): the rendered
// string differs each completed refresh (forcing a re-announce) while the spoken text stays
// "Inbox updated". The deleted banner re-announced via its changing "N new updates" summary;
// this preserves that parity without speaking a count.
const ANNOUNCE_VARIANTS = [ANNOUNCE_TEXT, ANNOUNCE_TEXT + String.fromCharCode(0x200b)];

export function useInboxUpdates({ onUpdate }: Options): { announce: string } {
  const stream = useEventSource();
  const [announce, setAnnounce] = useState('');

  const onUpdateRef = useRef(onUpdate);
  useEffect(() => {
    onUpdateRef.current = onUpdate;
  }, [onUpdate]);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  const pending = useRef(false);
  const announceCount = useRef(0);

  const run = useCallback(async () => {
    if (inFlight.current) {
      pending.current = true; // queue exactly one trailing reload
      return;
    }
    inFlight.current = true;
    try {
      await onUpdateRef.current();
      setAnnounce(ANNOUNCE_VARIANTS[announceCount.current % 2]);
      announceCount.current += 1;
    } catch {
      // Swallow — keep current data, no banner/toast. Manual Refresh is the recovery path.
    } finally {
      inFlight.current = false;
      if (pending.current) {
        pending.current = false;
        void run();
      }
    }
  }, []);

  useEffect(() => {
    if (!stream) return;
    const unsubscribe = stream.on('inbox-updated', () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      debounceTimer.current = setTimeout(() => void run(), DEBOUNCE_MS);
    });
    return () => {
      unsubscribe();
      // Cancel a pending debounce too, so a timer started under a now-stale stream
      // (reconnect) or at unmount can't fire a reload after teardown.
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [stream, run]);

  return { announce };
}
