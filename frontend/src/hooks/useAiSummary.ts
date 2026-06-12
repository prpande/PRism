import { useEffect, useState } from 'react';
import { getAiSummaryResult } from '../api/aiSummary';
import type { PrReference, PrSummary } from '../api/types';

export interface AiSummaryState {
  summary: PrSummary | null;
  loading: boolean;
  error: boolean;
}

export function useAiSummary(
  prRef: PrReference,
  enabled: boolean,
  subscribed: boolean,
): AiSummaryState {
  const [state, setState] = useState<AiSummaryState>({
    summary: null,
    loading: false,
    error: false,
  });

  useEffect(() => {
    // Gate on subscription-established (spec §6): a fetch fired before the SSE subscription
    // registers would hit the D111 204 and never recover, since this effect's deps wouldn't change.
    if (!enabled || !subscribed) {
      setState({ summary: null, loading: false, error: false });
      return;
    }
    let cancelled = false;
    setState({ summary: null, loading: true, error: false });
    getAiSummaryResult(prRef).then((r) => {
      if (cancelled) return;
      if (r.kind === 'ok') setState({ summary: r.summary, loading: false, error: false });
      else if (r.kind === 'error') setState({ summary: null, loading: false, error: true });
      else setState({ summary: null, loading: false, error: false }); // absent (204) → hidden
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, subscribed]);

  return state;
}
