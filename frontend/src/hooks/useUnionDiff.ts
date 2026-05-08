import { useEffect, useState } from 'react';
import { getDiffByCommits } from '../api/diff';
import type { DiffDto, PrReference } from '../api/types';
import { useDelayedLoading } from './useDelayedLoading';

export interface UseUnionDiffResult {
  data: DiffDto | null;
  isLoading: boolean;
  showSkeleton: boolean;
  error: Error | null;
}

export function useUnionDiff(prRef: PrReference, commits: string[] | null): UseUnionDiffResult {
  const [data, setData] = useState<DiffDto | null>(null);
  const [isLoading, setIsLoading] = useState(commits !== null);
  const [error, setError] = useState<Error | null>(null);

  const commitsKey = commits?.join(',') ?? null;

  useEffect(() => {
    if (commits === null || commits.length === 0) {
      setData(null);
      setIsLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    getDiffByCommits(prRef, commits)
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
  }, [prRef.owner, prRef.repo, prRef.number, commitsKey]);

  const showSkeleton = useDelayedLoading(isLoading);
  return { data, isLoading, showSkeleton, error };
}
