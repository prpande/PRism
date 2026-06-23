import { useCallback, useMemo, useRef, useState } from 'react';
import { postFileViewed } from '../api/fileViewed';
import type { PrReference } from '../api/types';

export interface FileViewState {
  viewedPaths: Set<string>;
  toggleViewed: (path: string) => void;
}

// Count files (by path) present in `viewedPaths`. Shared by the Overview
// "Viewed" tile and the Files-tab tree header so the intersection derivation
// lives in exactly one place. Filtering over `files` keeps the result bounded
// to the caller's file list (0 ≤ n ≤ files.length) regardless of what extra
// paths `viewedPaths` carries.
export function countViewedFiles(
  files: readonly { path: string }[],
  viewedPaths: Set<string>,
): number {
  return files.reduce((n, f) => (viewedPaths.has(f.path) ? n + 1 : n), 0);
}

const EMPTY_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

// Single shared source of per-file "viewed" state (#442). `viewedPaths` is
// DERIVED from the persisted, head-matched file-view state plus a local
// optimistic overlay — never a seeded-and-owned mutable Set. The overlay model
// is what makes the two races the seed-once design hit impossible:
//   - a toggle made before the draft-session GET resolves lands in the overlay
//     and is layered onto the server set the moment it arrives (neither lost);
//   - a later refetch that carries newer server state is reflected automatically
//     (the overlay still wins for in-flight paths).
//
// The overlay is keyed by `owner/repo/number@headSha`. When the key changes —
// a new PR or a head advance — the overlay reads as empty, so viewed state
// resets to the new head's persisted set (prior-head marks are stale; the
// backend rejects writes at a stale head, so viewed-state is head-scoped).
export function useFileViewState(
  prRef: PrReference,
  headSha: string | undefined,
  persistedViewedFiles: Record<string, string> | undefined,
): FileViewState {
  const { owner, repo, number } = prRef;
  const key = headSha ? `${owner}/${repo}/${number}@${headSha}` : null;

  // path -> desired viewed flag, scoped to the key it was written under.
  const [overlay, setOverlay] = useState<{ key: string | null; map: ReadonlyMap<string, boolean> }>(
    () => ({ key: null, map: EMPTY_OVERRIDES }),
  );
  // Overrides only apply to the current key; on a key change they read as empty
  // without a reset effect (and without a one-render flash of stale entries).
  const overrides = overlay.key === key ? overlay.map : EMPTY_OVERRIDES;

  // Head-matched persisted set: a viewed entry stamped at a different head is
  // stale and does not count.
  const serverViewed = useMemo(() => {
    const s = new Set<string>();
    if (persistedViewedFiles && headSha) {
      for (const [path, sha] of Object.entries(persistedViewedFiles)) {
        if (sha === headSha) s.add(path);
      }
    }
    return s;
  }, [persistedViewedFiles, headSha]);

  const viewedPaths = useMemo(() => {
    if (overrides.size === 0) return serverViewed;
    const s = new Set(serverViewed);
    for (const [path, viewed] of overrides) {
      if (viewed) s.add(path);
      else s.delete(path);
    }
    return s;
  }, [serverViewed, overrides]);

  // Read the live derived set through a ref so `toggleViewed` stays
  // referentially stable across viewed changes (it does not re-create each time
  // a file is marked, which would churn the context value it feeds).
  const viewedRef = useRef(viewedPaths);
  viewedRef.current = viewedPaths;

  const toggleViewed = useCallback(
    (path: string) => {
      if (!key || !headSha) return; // detail not loaded — no head to stamp against
      const desired = !viewedRef.current.has(path);
      setOverlay((prev) => {
        const base = prev.key === key ? prev.map : EMPTY_OVERRIDES;
        const next = new Map(base);
        next.set(path, desired);
        return { key, map: next };
      });
      postFileViewed({ owner, repo, number }, { path, headSha, viewed: desired }).catch(() => {
        // Roll back to the server truth by dropping the optimistic override.
        setOverlay((prev) => {
          if (prev.key !== key || !prev.map.has(path)) return prev;
          const next = new Map(prev.map);
          next.delete(path);
          return { key, map: next };
        });
      });
    },
    [owner, repo, number, headSha, key],
  );

  return { viewedPaths, toggleViewed };
}
