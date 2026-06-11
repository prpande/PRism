import { useEffect, useState } from 'react';
import { getAiDraftSuggestions } from '../api/aiDraftSuggestions';
import type { PrReference, DraftSuggestion } from '../api/types';

export function useAiDraftSuggestions(
  prRef: PrReference,
  enabled: boolean,
): DraftSuggestion[] | null {
  const [entries, setEntries] = useState<DraftSuggestion[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiDraftSuggestions(prRef)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return entries;
}
