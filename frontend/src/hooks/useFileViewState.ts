import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

const EMPTY_MAP: ReadonlyMap<string, boolean> = new Map();

type ScopedMap = { key: string | null; map: ReadonlyMap<string, boolean> };

// Drop the entry for `path` from a key-scoped map, returning the same reference
// when nothing changes so React can bail out of the re-render.
function withoutPath(prev: ScopedMap, key: string, path: string): ScopedMap {
  if (prev.key !== key || !prev.map.has(path)) return prev;
  const next = new Map(prev.map);
  next.delete(path);
  return { key, map: next };
}

// Write `path -> value` into a key-scoped map, discarding any entries written
// under a different key (a key change reads as empty — no reset effect needed).
function withPath(prev: ScopedMap, key: string, path: string, value: boolean): ScopedMap {
  const base = prev.key === key ? prev.map : EMPTY_MAP;
  const next = new Map(base);
  next.set(path, value);
  return { key, map: next };
}

// Single shared source of per-file "viewed" state (#442). `viewedPaths` is
// DERIVED from the persisted, head-matched file-view state plus two local
// overlays — never a seeded-and-owned mutable Set:
//   - `pending` holds the optimistic value of an in-flight POST;
//   - `confirmed` holds the value of the most recently ACKed POST, bridging the
//     gap until the next server refetch reflects it (a file-viewed POST does not
//     itself trigger a draft-session refetch, so `serverViewed` lags a success).
//
// Layering is serverViewed -> confirmed -> pending (pending wins, then
// confirmed, then server). This is what makes the #442/#600 races correct:
//   - a toggle made before the draft-session GET resolves lands in `pending` and
//     is layered onto the server set the moment it arrives (neither lost);
//   - on POST success the override moves from `pending` to `confirmed`, so the
//     mark survives until the server catches up (no flash back to not-viewed);
//   - on POST failure the override is dropped from `pending`, falling back to
//     the prior ACKed value (`confirmed`) or `serverViewed` — never a stale {}.
//
// Both overlays are keyed by `owner/repo/number@headSha`. When the key changes —
// a new PR or a head advance — they read as empty, so viewed state resets to the
// new head's persisted set (prior-head marks are stale; the backend rejects
// writes at a stale head, so viewed-state is head-scoped).
export function useFileViewState(
  prRef: PrReference,
  headSha: string | undefined,
  persistedViewedFiles: Record<string, string> | undefined,
): FileViewState {
  const { owner, repo, number } = prRef;
  const key = headSha ? `${owner}/${repo}/${number}@${headSha}` : null;

  // path -> optimistic value of the in-flight POST, scoped to its key.
  const [pending, setPending] = useState<ScopedMap>(() => ({ key: null, map: EMPTY_MAP }));
  // path -> value of the last ACKed POST, scoped to its key. Bridges the window
  // between a successful POST and the server refetch that reflects it.
  const [confirmed, setConfirmed] = useState<ScopedMap>(() => ({ key: null, map: EMPTY_MAP }));

  // Overlays only apply to the current key; on a key change they read as empty
  // without a reset effect (and without a one-render flash of stale entries).
  const pendingMap = pending.key === key ? pending.map : EMPTY_MAP;
  const confirmedMap = confirmed.key === key ? confirmed.map : EMPTY_MAP;

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

  // Evict ACKed overrides the server snapshot has caught up to: once
  // `serverViewed` agrees with `confirmed[path]`, the bridge is redundant, and
  // removing it lets any LATER divergence (the file un-viewed elsewhere) win
  // instead of being shadowed indefinitely (#600 Bug A). `serverViewed` is a
  // referentially-stable memo, so this only runs when the snapshot changes.
  useEffect(() => {
    setConfirmed((prev) => {
      if (prev.key !== key || prev.map.size === 0) return prev;
      let next: Map<string, boolean> | null = null;
      for (const [path, value] of prev.map) {
        if (serverViewed.has(path) === value) {
          next ??= new Map(prev.map);
          next.delete(path);
        }
      }
      return next ? { key, map: next } : prev;
    });
  }, [serverViewed, key]);

  const viewedPaths = useMemo(() => {
    if (confirmedMap.size === 0 && pendingMap.size === 0) return serverViewed;
    const s = new Set(serverViewed);
    // Apply the overlays in priority order: confirmed over server, then pending
    // over confirmed (so the in-flight intent wins). An entry's value is the
    // desired viewed flag — add on true, remove on false.
    const apply = (overlay: ReadonlyMap<string, boolean>) => {
      for (const [path, viewed] of overlay) {
        if (viewed) s.add(path);
        else s.delete(path);
      }
    };
    apply(confirmedMap);
    apply(pendingMap);
    return s;
  }, [serverViewed, confirmedMap, pendingMap]);

  // Read the live derived set through a ref so `toggleViewed` stays
  // referentially stable across viewed changes (it does not re-create each time
  // a file is marked, which would churn the context value it feeds).
  const viewedRef = useRef(viewedPaths);
  viewedRef.current = viewedPaths;

  // Per-path issue counter. Each toggle bumps its path's generation; a POST's
  // success/failure handler only fires if no newer toggle for that path has been
  // issued since. This keeps a late-completing older request from clobbering the
  // user's latest intent even when same-path POSTs complete out of order.
  const genRef = useRef(new Map<string, number>());

  const toggleViewed = useCallback(
    (path: string) => {
      if (!key || !headSha) return; // detail not loaded — no head to stamp against
      const desired = !viewedRef.current.has(path);
      const gen = (genRef.current.get(path) ?? 0) + 1;
      genRef.current.set(path, gen);
      setPending((prev) => withPath(prev, key, path, desired));
      postFileViewed({ owner, repo, number }, { path, headSha, viewed: desired }).then(
        () => {
          // A newer toggle superseded this request — leave its state alone.
          if (genRef.current.get(path) !== gen) return;
          // Success: retire the optimistic value to `confirmed` so the mark
          // survives until the server refetch reflects it.
          setPending((prev) => withoutPath(prev, key, path));
          setConfirmed((prev) => withPath(prev, key, path, desired));
        },
        () => {
          if (genRef.current.get(path) !== gen) return;
          // Failure: drop the optimistic value, falling back to the prior ACKed
          // value (`confirmed`) or `serverViewed` — the real prior state.
          setPending((prev) => withoutPath(prev, key, path));
        },
      );
    },
    [owner, repo, number, headSha, key],
  );

  return { viewedPaths, toggleViewed };
}
