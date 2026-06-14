import { useCallback, useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import { ApiError } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, HunkAnnotation } from '../api/types';

export function useAiHunkAnnotations(prRef: PrReference, enabled: boolean): HunkAnnotation[] | null {
  const [entries, setEntries] = useState<HunkAnnotation[] | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      clear(prRef, 'hunk-annotations');
      return;
    }
    let cancelled = false;
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (cancelled) return;
        setEntries(result);
        clear(prRef, 'hunk-annotations');
      })
      .catch((err) => {
        if (cancelled) return;
        setEntries(null);
        if (err instanceof ApiError && err.status === 401) clear(prRef, 'hunk-annotations');
        else report(prRef, 'hunk-annotations', { retry });
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return entries;
}
