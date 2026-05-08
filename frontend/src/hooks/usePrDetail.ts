import { useEffect, useState } from 'react';
import { getPrDetail } from '../api/prDetail';
import type { PrDetailDto, PrReference } from '../api/types';
import { useDelayedLoading } from './useDelayedLoading';

export interface UsePrDetailResult {
  data: PrDetailDto | null;
  isLoading: boolean;
  showSkeleton: boolean;
  error: Error | null;
  reload: () => void;
}

export function usePrDetail(prRef: PrReference): UsePrDetailResult {
  const [data, setData] = useState<PrDetailDto | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [reloadCounter, setReloadCounter] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getPrDetail(prRef)
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setIsLoading(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e : new Error(String(e)));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [prRef.owner, prRef.repo, prRef.number, reloadCounter]);

  const showSkeleton = useDelayedLoading(isLoading);
  const reload = () => setReloadCounter((c) => c + 1);
  return { data, isLoading, showSkeleton, error, reload };
}
