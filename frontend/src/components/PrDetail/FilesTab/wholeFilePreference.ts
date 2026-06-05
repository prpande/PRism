// wholeFilePreference.ts
import { useState, useCallback } from 'react';

export interface DeriveWholeFileParams {
  showFullFile: boolean;
  failedPaths: Set<string>;
  selectedPath: string | null;
  selectedFileStatus: string | undefined;
  selectedFileHunkCount: number;
  iterationGatePermits: boolean;
}

/** Single source of truth for per-file whole-file eligibility (status + hunks).
 * Used by both deriveWholeFileEnabled and FilesTab's inert-note computation so
 * the rule has one home. */
export function isWholeFileEligible(status: string | undefined, hunkCount: number): boolean {
  return status === 'modified' && hunkCount > 0;
}

/** The effective per-current-file whole-file flag passed to DiffPane. */
export function deriveWholeFileEnabled(p: DeriveWholeFileParams): boolean {
  return (
    p.showFullFile &&
    p.selectedPath !== null &&
    !p.failedPaths.has(p.selectedPath) &&
    p.iterationGatePermits &&
    isWholeFileEligible(p.selectedFileStatus, p.selectedFileHunkCount)
  );
}

export interface WholeFilePreference {
  showFullFile: boolean;
  /** Direction-aware: setting true clears failedPaths (a retry affordance). */
  setShowFullFile: (next: boolean) => void;
  failedPaths: Set<string>;
  markFailed: (path: string) => void;
}

export function useWholeFilePreference(): WholeFilePreference {
  const [showFullFile, setShow] = useState(false);
  const [failedPaths, setFailedPaths] = useState<Set<string>>(new Set());

  const setShowFullFile = useCallback((next: boolean) => {
    setShow((prev) => {
      // Clear the failed set only on a genuine false -> true transition.
      if (next && !prev) setFailedPaths(new Set());
      return next;
    });
  }, []);

  const markFailed = useCallback((path: string) => {
    setFailedPaths((prev) => {
      if (prev.has(path)) return prev;
      const next = new Set(prev);
      next.add(path);
      return next;
    });
  }, []);

  return { showFullFile, setShowFullFile, failedPaths, markFailed };
}
