import { useCallback, useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import { ApiError, readFailureReason } from '../api/client';
import { useAiFailure } from '../components/Ai/aiFailure';
import type { PrReference, DraftSuggestion, AiLoadState } from '../api/types';

export interface AiDraftSuggestionsState {
  state: AiLoadState;
  suggestions: DraftSuggestion[] | null;
}

export function useAiDraftSuggestions(
  prRef: PrReference,
  enabled: boolean,
): AiDraftSuggestionsState {
  // Lazy initializer keyed on `enabled` so a gated-off hook starts in 'empty', not
  // 'loading' — otherwise the first render reports state==='loading' before the effect
  // corrects it, briefly signalling "working" when AI is off here.
  const [value, setValue] = useState<AiDraftSuggestionsState>(() => ({
    state: enabled ? 'loading' : 'empty',
    suggestions: null,
  }));
  const [retryNonce, setRetryNonce] = useState(0);
  const retry = useCallback(() => setRetryNonce((n) => n + 1), []);
  const { report, clear } = useAiFailure();

  useEffect(() => {
    if (!enabled) {
      setValue({ state: 'empty', suggestions: null });
      clear(prRef, 'draft-suggestions');
      return;
    }
    let cancelled = false;
    setValue({ state: 'loading', suggestions: null });
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (cancelled) return;
        // getAiDraftSuggestions resolves null on a 204 — guard before .length (see Task 1).
        const arr = result ?? [];
        setValue({ state: arr.length > 0 ? 'ready' : 'empty', suggestions: result });
        clear(prRef, 'draft-suggestions');
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          setValue({ state: 'empty', suggestions: null });
          clear(prRef, 'draft-suggestions');
        } else {
          setValue({ state: 'error', suggestions: null });
          report(prRef, 'draft-suggestions', { retry, reason: readFailureReason(err) });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable primitive prRef fields; retryNonce re-runs the fetch (cleanup cancels the prior); report/clear/retry are stable (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled, retryNonce]);

  return value;
}
