import { useCallback, useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, DraftSuggestion } from '../api/types';

export function useAiDraftSuggestions(
  prRef: PrReference,
  enabled: boolean,
): DraftSuggestion[] | null {
  const [entries, setEntries] = useState<DraftSuggestion[] | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      clear(prRef, 'draft-suggestions');
      return;
    }
    let cancelled = false;
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
        clear(prRef, 'draft-suggestions');
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'draft-suggestions');
        else report(prRef, 'draft-suggestions', { retry });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return entries;
}
