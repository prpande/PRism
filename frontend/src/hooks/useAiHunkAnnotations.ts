import { useCallback, useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import { ApiError, readFailureReason } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, HunkAnnotation, AiLoadState } from '../api/types';

export interface AiHunkAnnotationsState {
  state: AiLoadState;
  annotations: HunkAnnotation[] | null;
}

export function useAiHunkAnnotations(prRef: PrReference, enabled: boolean): AiHunkAnnotationsState {
  // Lazy initializer keyed on `enabled` so a gated-off hook starts in 'empty', not
  // 'loading'. Otherwise the first render reports state==='loading' (→ a "working"
  // header-marker flash) before the effect corrects it — wrong when AI is off here.
  const [value, setValue] = useState<AiHunkAnnotationsState>(() => ({
    state: enabled ? 'loading' : 'empty',
    annotations: null,
  }));
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setValue({ state: 'empty', annotations: null });
      clear(prRef, 'hunk-annotations');
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading', annotations: null });
    getAiHunkAnnotations(prRef)
      .then((result) => {
        if (cancelled) return;
        // getAiHunkAnnotations resolves null on a 204 — guard before .length (else TypeError
        // rejects into .catch and a legitimate "no annotations" becomes a spurious 'error').
        const arr = result ?? [];
        setValue({ state: arr.length > 0 ? 'ready' : 'empty', annotations: result });
        clear(prRef, 'hunk-annotations');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setValue({ state: 'empty', annotations: null });
          clear(prRef, 'hunk-annotations');
        } else {
          setValue({ state: 'error', annotations: null });
          report(prRef, 'hunk-annotations', { retry, reason: readFailureReason(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return value;
}
