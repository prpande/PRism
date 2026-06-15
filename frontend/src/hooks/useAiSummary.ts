import { useCallback, useEffect, useRef, useState } from 'react';
import { getAiSummaryResult, regenerateAiSummary } from '../api/aiSummary';
import { useAiFailure } from '../components/Ai/aiFailure';
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

  const { report, clear } = useAiFailure();

  // Declared ABOVE the initial-fetch effect so the effect can pass `regenerate` as the retry
  // closure without a forward-reference issue. The eslint comment on the effect suppresses the
  // resulting exhaustive-deps warning (regenerate is stable by its own deps list).
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
        clear(prRef, 'summary');
      } else if (r.kind === 'error') {
        setRegenerateError(true); // retain the present body (§9)
        report(prRef, 'summary', { retry: regenerate });
      } else if (r.kind === 'auth') {
        // Auth failure on regenerate: show the inline regenerate-error block, but do NOT report
        // to the toast (matches file-focus: inline error, no global toast on auth).
        setRegenerateError(true);
        clear(prRef, 'summary');
      } else {
        // 'absent' — not a surface-worthy failure
        clear(prRef, 'summary');
      }
    } finally {
      inFlight.current = false;
      setRegenerating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields (#331/#374); report/clear/regenerate are stable
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed]);

  useEffect(() => {
    if (!enabled || !subscribed) {
      setSummary(null);
      setLoading(false);
      setError(false);
      clear(prRef, 'summary'); // AI off / not-subscribed must not leave a stale failure
      return;
    }
    let cancelled = false;
    setSummary(null);
    setLoading(true);
    setError(false);
    // Reset staleness + regenerate-error per fetch so each PR/enable change starts clean and the
    // hook does not depend on the parent re-latching baseShaChanged to false on prRef change. A
    // base-change SSE does NOT re-run this effect (baseShaChanged is out of deps), so this reset
    // never fires on a base move — the rising-edge effect below owns that.
    setStaleCleared(false);
    setRegenerateError(false);
    getAiSummaryResult(prRef).then((r) => {
      if (cancelled) return;
      if (r.kind === 'ok') {
        setSummary(r.summary);
        setLoading(false);
        setError(false);
        clear(prRef, 'summary');
        // Only mark as not-stale if no base-change has arrived (current or during fetch).
        // If baseShaChanged is true, the fetched summary is already stale — don't clear it.
        if (!baseShaChangedRef.current) setStaleCleared(true);
      } else if (r.kind === 'error') {
        setSummary(null);
        setLoading(false);
        setError(true);
        // Retry for a failed initial GET is regenerate (POST) — a deliberate spec choice; it re-generates (token cost), not a plain re-fetch. Do not "fix" to getAiSummaryResult.
        report(prRef, 'summary', { retry: regenerate });
      } else if (r.kind === 'auth') {
        // Auth failure on initial fetch: show the inline error block (matches pre-#484 behaviour
        // and file-focus parity — inline error, no global toast on auth).
        setSummary(null);
        setLoading(false);
        setError(true);
        clear(prRef, 'summary');
      } else {
        // 'absent' — not a surface-worthy failure
        setSummary(null);
        setLoading(false);
        setError(false);
        clear(prRef, 'summary');
      }
    });
    return () => {
      cancelled = true;
    };
    // baseShaChanged is INTENTIONALLY omitted from deps: a base move must not auto-refetch (token
    // discipline). regenerate() is the only re-fetch trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; baseShaChanged omitted by design (#374); report/clear/regenerate are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed]);

  // A rising base-change edge re-stales the card (un-clears the local override).
  useEffect(() => {
    if (baseShaChanged) setStaleCleared(false);
  }, [baseShaChanged]);

  const isStale = baseShaChanged && !staleCleared;

  return { summary, loading, error, isStale, regenerating, regenerateError, regenerate };
}
