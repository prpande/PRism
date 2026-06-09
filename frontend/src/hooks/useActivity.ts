import { useEffect, useRef, useState } from 'react';
import { getActivity } from '../api/activity';
import type { ActivityResponse } from '../api/types';

const POLL_MS = 90_000;

export interface UseActivityResult {
  data: ActivityResponse | null;
  isLoading: boolean;
  error: Error | null;
}

// Polls /api/activity every ~90s. Retains last-good data across a failed poll
// (no error flash on a transient blip), mirroring usePrDetail's preservation rule.
// Tab-hidden visibility-pause is deferred to P2 (the 3-call cost makes it worth it there).
export function useActivity(): UseActivityResult {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const dataRef = useRef<ActivityResponse | null>(null);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const next = await getActivity();
        if (cancelled) return;
        dataRef.current = next;
        setData(next);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        // Keep dataRef.current (last good) — do NOT clear data.
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    };

    void poll();
    const id = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { data, isLoading, error };
}
