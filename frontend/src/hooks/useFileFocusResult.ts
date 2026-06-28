import { useCallback, useEffect, useState } from 'react';
import { getAiFileFocusResult } from '../api/aiFileFocus';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { FileFocus, FileFocusStatus, PrReference } from '../api/types';

export interface FileFocusState {
  status: FileFocusStatus;
  entries: FileFocus[];
  // User-initiated re-fetch for the error state (re-issues the GET; cached → no extra spend). NOT a
  // re-rank: a cached fallback is served as-is (token discipline). Stable identity.
  retry: () => void;
}

// The SINGLE shared file-focus fetch (spec §8). One owner (PrDetailView → prDetailContext) calls
// this; the Files-tree dots and the Hotspots tab both read the result — no duplicate GET. `enabled`
// = fileFocus capability on (Preview or Live). `subscribed` gates the Live fetch (D111). A base/head
// move does NOT auto-refetch (token discipline) — eviction happens server-side; the next view re-GETs.
export function useFileFocusResult(
  prRef: PrReference,
  enabled: boolean,
  subscribed: boolean,
): FileFocusState {
  const [state, setState] = useState<{ status: FileFocusStatus; entries: FileFocus[] }>({
    status: 'loading',
    entries: [],
  });
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'no-changes', entries: [] }); // tab is not rendered when disabled; benign
      clear(prRef, 'file-focus');
      return;
    }
    if (!subscribed) {
      setState({ status: 'not-subscribed', entries: [] });
      clear(prRef, 'file-focus');
      return;
    }
    let cancelled = false;
    // #603 item D — abort the abandoned fetch on PR-switch / gate-toggle /
    // unmount instead of only discarding its resolution. Mirrors
    // useWholeFileContent.
    const controller = new AbortController();
    setState({ status: 'loading', entries: [] });
    getAiFileFocusResult(prRef, controller.signal)
      .then((outcome) => {
        if (cancelled) return;
        if (outcome.kind === 'no-content') {
          setState({ status: 'no-changes', entries: [] });
          clear(prRef, 'file-focus');
        } else if (outcome.kind === 'auth') {
          setState({ status: 'error', entries: [] });
          clear(prRef, 'file-focus'); // inline unchanged; no report
        } else if (outcome.kind === 'error') {
          setState({ status: 'error', entries: [] });
          report(prRef, 'file-focus', { retry, reason: outcome.reason });
        } else {
          const { entries, fallback } = outcome.result;
          // fallback checked BEFORE entries — a fallback is never rendered as rows (spec §8).
          if (fallback) {
            setState({ status: 'fallback', entries });
          } else {
            const hasSignal = entries.some((e) => e.level === 'high' || e.level === 'medium');
            setState({ status: hasSignal ? 'ok' : 'empty', entries });
          }
          clear(prRef, 'file-focus');
        }
      })
      // Defensive: getAiFileFocusResult maps all throws to discriminated outcomes (never rejects today); this guards a future change where it might.
      .catch(() => {
        if (!cancelled) {
          setState({ status: 'error', entries: [] });
          report(prRef, 'file-focus', { retry, reason: 'provider-error' });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
    // retryNonce bumps re-run the effect (error-state Retry); base move does NOT auto-refetch (#374).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed, retryNonce]);

  return { ...state, retry };
}
