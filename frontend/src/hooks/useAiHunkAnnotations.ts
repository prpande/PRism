import { useEffect, useState } from 'react';
import { getAiHunkAnnotations } from '../api/aiHunkAnnotations';
import type { PrReference, HunkAnnotation } from '../api/types';

export function useAiHunkAnnotations(
  prRef: PrReference,
  enabled: boolean,
): HunkAnnotation[] | null {
  const [entries, setEntries] = useState<HunkAnnotation[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiHunkAnnotations(prRef)
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
