import { useEffect, useMemo, useRef, useState } from 'react';
import type { FileChange, PrReference } from '../api/types';

export interface UseWholeFileContentInput {
  prRef: PrReference;
  path: string | null;
  file: FileChange | null;
  headSha: string;
  baseSha: string;
  enabled: boolean;
  isSplit: boolean;
}

export interface UseWholeFileContentResult {
  fetchStatus: 'idle' | 'loading' | 'ok' | 'failed';
  headContent: string | null;
  baseContent: string | null;
  failureReason: string | null;
}

interface CacheValue {
  kind: 'ok' | 'failed';
  headContent?: string;
  baseContent?: string;
  failureReason?: string;
}

function mapProblemType(type: string | undefined): string {
  switch (type) {
    case '/file/too-large':
      return 'file is too large to expand';
    case '/file/binary':
      return 'file is binary';
    case '/file/missing':
      return 'file not present at this revision';
    case '/file/not-in-diff':
    case '/file/truncation-window':
      return 'file not available in current diff snapshot';
    case '/file/snapshot-evicted':
      return 'diff snapshot has been evicted — reload the PR';
    default:
      return 'could not load file';
  }
}

async function fetchOne(
  prRef: PrReference,
  path: string,
  sha: string,
  signal: AbortSignal,
): Promise<{ kind: 'ok'; content: string } | { kind: 'failed'; reason: string }> {
  const url = `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/file?path=${encodeURIComponent(path)}&sha=${sha}`;
  let resp: Response;
  try {
    resp = await fetch(url, { credentials: 'include', signal });
  } catch {
    return { kind: 'failed', reason: 'could not load file' };
  }
  if (resp.ok) {
    return { kind: 'ok', content: await resp.text() };
  }
  let problemType: string | undefined;
  try {
    const body = (await resp.json()) as { type?: string };
    problemType = body.type;
  } catch {
    /* malformed problem details — fall through to default reason */
  }
  return { kind: 'failed', reason: mapProblemType(problemType) };
}

export function useWholeFileContent(input: UseWholeFileContentInput): UseWholeFileContentResult {
  const { prRef, path, file, headSha, baseSha, enabled, isSplit } = input;
  // TODO: bounded cache — PoC scope leaves this unbounded. Single-PR review
  // sessions touch <100 keys; if cross-session caching arrives, add LRU.
  const cacheRef = useRef<Map<string, CacheValue>>(new Map());
  const [state, setState] = useState<UseWholeFileContentResult>({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  });

  // Deps use primitives derived from `file`, not the object reference itself.
  // FilesTab's `selectedFile = files.find(...)` returns a new object every
  // render; depending on the object ref would re-compute `inactive` and re-fire
  // the effect on unrelated parent re-renders, causing spurious loading flashes.
  const inactive = useMemo(
    () =>
      !enabled ||
      path === null ||
      file === null ||
      file.status !== 'modified' ||
      file.hunks.length === 0,
    [enabled, path, file === null, file?.status, file?.hunks.length],
  );

  useEffect(() => {
    if (inactive || path === null) {
      setState({ fetchStatus: 'idle', headContent: null, baseContent: null, failureReason: null });
      return;
    }
    const key = `${path}::${headSha}::${baseSha}::${isSplit}`;
    const cached = cacheRef.current.get(key);
    if (cached) {
      if (cached.kind === 'ok') {
        setState({
          fetchStatus: 'ok',
          headContent: cached.headContent ?? null,
          baseContent: cached.baseContent ?? null,
          failureReason: null,
        });
      } else {
        setState({
          fetchStatus: 'failed',
          headContent: null,
          baseContent: null,
          failureReason: cached.failureReason ?? 'could not load file',
        });
      }
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    setState({ fetchStatus: 'loading', headContent: null, baseContent: null, failureReason: null });

    void (async () => {
      const headPromise = fetchOne(prRef, path, headSha, controller.signal);
      const basePromise = isSplit
        ? fetchOne(prRef, path, baseSha, controller.signal)
        : Promise.resolve({ kind: 'ok', content: '' } as const);
      const [headResult, baseResult] = await Promise.all([headPromise, basePromise]);

      let value: CacheValue;
      if (headResult.kind === 'failed' && (!isSplit || baseResult.kind === 'ok')) {
        value = {
          kind: 'failed',
          failureReason: isSplit ? `new-side ${headResult.reason}` : headResult.reason,
        };
      } else if (isSplit && baseResult.kind === 'failed' && headResult.kind === 'ok') {
        value = {
          kind: 'failed',
          failureReason: `old-side ${baseResult.reason}`,
        };
      } else if (isSplit && baseResult.kind === 'failed' && headResult.kind === 'failed') {
        value = {
          kind: 'failed',
          failureReason: `new-side ${headResult.reason}`,
        };
      } else if (headResult.kind === 'ok') {
        value = {
          kind: 'ok',
          headContent: headResult.content,
          baseContent: isSplit && baseResult.kind === 'ok' ? baseResult.content : undefined,
        };
      } else {
        value = { kind: 'failed', failureReason: 'could not load file' };
      }

      // Skip cache write AND setState if the effect was cancelled — an aborted
      // fetch (signal.aborted) would otherwise poison the cache with a stale
      // 'could not load file' entry, served on next request for the same key.
      if (cancelled || controller.signal.aborted) return;
      cacheRef.current.set(key, value);
      if (value.kind === 'ok') {
        setState({
          fetchStatus: 'ok',
          headContent: value.headContent ?? null,
          baseContent: value.baseContent ?? null,
          failureReason: null,
        });
      } else {
        setState({
          fetchStatus: 'failed',
          headContent: null,
          baseContent: null,
          failureReason: value.failureReason ?? 'could not load file',
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // Spread prRef into primitive deps to match neighbor hooks
    // (useAiHunkAnnotations / useFileDiff). A referentially-new prRef with
    // identical fields would otherwise re-fire the effect and cause a
    // transient 'loading' flash.
  }, [inactive, path, headSha, baseSha, isSplit, prRef.owner, prRef.repo, prRef.number]);

  return state;
}
