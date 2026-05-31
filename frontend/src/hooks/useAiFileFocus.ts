import { useEffect, useState } from 'react';
import { getAiFileFocus } from '../api/aiFileFocus';
import type { PrReference, FileFocus } from '../api/types';

// PR9b-ai-gating § 3.3. Mirrors useAiSummary's shape exactly. `null` is the
// union of three states: not-enabled, in-flight, 204/error. Downstream
// consumers (FileTree) render nothing for null — matches the off-state
// visual exactly. No isLoading flag in v1.
export function useAiFileFocus(prRef: PrReference, enabled: boolean): FileFocus[] | null {
  const [entries, setEntries] = useState<FileFocus[] | null>(null);

  useEffect(() => {
    if (!enabled) {
      setEntries(null);
      return;
    }
    let cancelled = false;
    getAiFileFocus(prRef)
      .then((result) => {
        if (!cancelled) setEntries(result);
      })
      .catch(() => {
        if (!cancelled) setEntries(null);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, enabled]);

  return entries;
}
