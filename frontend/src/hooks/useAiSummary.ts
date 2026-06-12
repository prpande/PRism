import { useCallback, useEffect, useRef, useState } from 'react';
import { getAiSummaryResult, regenerateAiSummary } from '../api/aiSummary';
import type { PrReference, PrSummary } from '../api/types';

export interface AiSummaryState {
  summary: PrSummary | null;
  loading: boolean;
  error: boolean;
  isStale: boolean;
  regenerating: boolean;
  regenerateError: boolean;
  regenerate: () => Promise<void>;
}

export function useAiSummary(
  prRef: PrReference,
  enabled: boolean,
  subscribed: boolean,
  baseShaChanged: boolean,
): AiSummaryState {
  const [summary, setSummary] = useState<PrSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenerateError, setRegenerateError] = useState(false);
  // isStale = baseShaChanged && !staleCleared. A fresh fetch/regenerate clears staleness even
  // while the parent's baseShaChanged latch stays true; a rising base-change edge re-stales.
  const [staleCleared, setStaleCleared] = useState(false);
  // Tracks the latest baseShaChanged value synchronously so the async fetch .then() can check
  // whether a base-change arrived while the fetch was in-flight (and avoid wrongly clearing it).
  const baseShaChangedRef = useRef(baseShaChanged);
  baseShaChangedRef.current = baseShaChanged;
  // Synchronous in-flight guard. A ref (not the `regenerating` state) closes the double-click
  // double-spend window that a state-based check leaves open under React 18 batching — two clicks
  // arriving before the first setState commit would both pass a state guard.
  const inFlight = useRef(false);

  useEffect(() => {
    if (!enabled || !subscribed) {
      setSummary(null);
      setLoading(false);
      setError(false);
      return;
    }
    let cancelled = false;
    setSummary(null);
    setLoading(true);
    setError(false);
    getAiSummaryResult(prRef).then((r) => {
      if (cancelled) return;
      if (r.kind === 'ok') {
        setSummary(r.summary);
        setLoading(false);
        setError(false);
        // Only mark as not-stale if no base-change has arrived (current or during fetch).
        // If baseShaChanged is true, the fetched summary is already stale — don't clear it.
        if (!baseShaChangedRef.current) setStaleCleared(true);
      } else if (r.kind === 'error') {
        setSummary(null);
        setLoading(false);
        setError(true);
      } else {
        setSummary(null);
        setLoading(false);
        setError(false);
      }
    });
    return () => {
      cancelled = true;
    };
    // baseShaChanged is INTENTIONALLY omitted from deps: a base move must not auto-refetch (token
    // discipline). regenerate() is the only re-fetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; baseShaChanged omitted by design (#374)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed]);

  // A rising base-change edge re-stales the card (un-clears the local override).
  useEffect(() => {
    if (baseShaChanged) setStaleCleared(false);
  }, [baseShaChanged]);

  const regenerate = useCallback(async () => {
    if (!enabled || !subscribed || inFlight.current) return; // ref guard is synchronous
    inFlight.current = true;
    setRegenerating(true);
    setRegenerateError(false); // "transient" = cleared on the next deliberate attempt (§9)
    try {
      const r = await regenerateAiSummary(prRef);
      if (r.kind === 'ok') {
        setSummary(r.summary);
        setStaleCleared(true);
      } else if (r.kind === 'error') {
        setRegenerateError(true); // retain the present body (§9)
      }
    } finally {
      inFlight.current = false;
      setRegenerating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields (#331/#374)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed]);

  const isStale = baseShaChanged && !staleCleared;

  return { summary, loading, error, isStale, regenerating, regenerateError, regenerate };
}
