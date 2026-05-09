import { useEffect, useState } from 'react';
import { getAiSummary } from '../api/aiSummary';
import type { PrReference, PrSummary } from '../api/types';

export function useAiSummary(prRef: PrReference, enabled: boolean): PrSummary | null {
  const [summary, setSummary] = useState<PrSummary | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    getAiSummary(prRef)
      .then((result) => {
        if (cancelled) return;
        setSummary(result);
      })
      .catch(() => {
        // Silent failure — AI summary is best-effort cosmetic; the rest of the
        // Overview tab renders without it. Errors surface in the network tab
        // for development, but no inline UI signals the failure.
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return summary;
}
