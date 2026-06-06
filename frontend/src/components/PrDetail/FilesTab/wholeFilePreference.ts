// wholeFilePreference.ts
import { useState, useCallback } from 'react';

export interface DeriveWholeFileParams {
  showFullFile: boolean;
  failedPaths: ReadonlySet<string>;
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
  /** Read-only to consumers; mutate only via markFailed / setShowFullFile. */
  failedPaths: ReadonlySet<string>;
  markFailed: (path: string) => void;
}

export function useWholeFilePreference(): WholeFilePreference {
  const [showFullFile, setShow] = useState(false);
  const [failedPaths, setFailedPaths] = useState<ReadonlySet<string>>(() => new Set());

  const setShowFullFile = useCallback(
    (next: boolean) => {
      // Clear the failed set only on a genuine false -> true transition (a retry
      // affordance). The condition is evaluated OUTSIDE the setShow updater so we
      // never call one state setter inside another setter's updater function —
      // React may double-invoke updaters (strict/concurrent mode), and an updater
      // must stay pure. `showFullFile` is in the dep array so the closure is fresh.
      if (next && !showFullFile) setFailedPaths(new Set());
      setShow(next);
    },
    [showFullFile],
  );

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
