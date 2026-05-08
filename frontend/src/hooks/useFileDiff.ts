import { useEffect, useState } from 'react';
import { getDiff } from '../api/diff';
import type { DiffDto, PrReference } from '../api/types';
import { useDelayedLoading } from './useDelayedLoading';

export interface UseFileDiffResult {
  data: DiffDto | null;
  isLoading: boolean;
  showSkeleton: boolean;
  error: Error | null;
}

export function useFileDiff(prRef: PrReference, range: string | null): UseFileDiffResult {
  const [data, setData] = useState<DiffDto | null>(null);
  const [isLoading, setIsLoading] = useState(range !== null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (range === null) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getDiff(prRef, range)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setData(null);
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, range]);

  const showSkeleton = useDelayedLoading(isLoading);
  return { data, isLoading, showSkeleton, error };
}
