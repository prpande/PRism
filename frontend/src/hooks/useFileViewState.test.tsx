import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useFileViewState, countViewedFiles } from './useFileViewState';
import { postFileViewed } from '../api/fileViewed';
import type { PrReference } from '../api/types';

vi.mock('../api/fileViewed', () => ({
  postFileViewed: vi.fn(),
}));

const postFileViewedMock = vi.mocked(postFileViewed);

const REF: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const HEAD = 'headsha';

beforeEach(() => {
  vi.clearAllMocks();
  postFileViewedMock.mockResolvedValue(undefined);
});

describe('countViewedFiles', () => {
  it('counts only files present in viewedPaths and stays bounded', () => {
    const files = [{ path: 'a.ts' }, { path: 'b.ts' }, { path: 'c.ts' }];
    expect(countViewedFiles(files, new Set(['a.ts', 'c.ts']))).toBe(2);
    expect(countViewedFiles(files, new Set())).toBe(0);
    // A viewed path absent from the file list does not inflate the count.
    expect(countViewedFiles(files, new Set(['a.ts', 'zzz.ts']))).toBe(1);
  });
});

describe('useFileViewState', () => {
  it('derives the head-matched persisted set and ignores stale-head entries', () => {
    const { result } = renderHook(() =>
      useFileViewState(REF, HEAD, { 'a.ts': HEAD, 'b.ts': 'oldhead', 'c.ts': HEAD }),
    );
    expect(result.current.viewedPaths).toEqual(new Set(['a.ts', 'c.ts']));
  });

  it('toggles a file viewed optimistically and POSTs the right body', async () => {
    const { result } = renderHook(() => useFileViewState(REF, HEAD, {}));

    act(() => result.current.toggleViewed('a.ts'));

    expect(result.current.viewedPaths.has('a.ts')).toBe(true);
    expect(postFileViewedMock).toHaveBeenCalledWith(REF, {
      path: 'a.ts',
      headSha: HEAD,
      viewed: true,
    });
  });

  it('unmarks a persisted-viewed file and POSTs viewed:false', async () => {
    const { result } = renderHook(() => useFileViewState(REF, HEAD, { 'a.ts': HEAD }));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    act(() => result.current.toggleViewed('a.ts'));

    expect(result.current.viewedPaths.has('a.ts')).toBe(false);
    expect(postFileViewedMock).toHaveBeenCalledWith(REF, {
      path: 'a.ts',
      headSha: HEAD,
      viewed: false,
    });
  });

  it('preserves a toggle made before the persisted state arrives (overlay race)', () => {
    const { result, rerender } = renderHook(
      ({ persisted }: { persisted: Record<string, string> | undefined }) =>
        useFileViewState(REF, HEAD, persisted),
      { initialProps: { persisted: undefined as Record<string, string> | undefined } },
    );

    // User toggles a file viewed before the draft-session GET resolves.
    act(() => result.current.toggleViewed('local.ts'));
    expect(result.current.viewedPaths).toEqual(new Set(['local.ts']));

    // Persisted state arrives carrying OTHER files viewed at the current head.
    rerender({ persisted: { 'server.ts': HEAD } });

    // Both the just-arrived persisted file and the local toggle are present —
    // neither is clobbered.
    expect(result.current.viewedPaths).toEqual(new Set(['server.ts', 'local.ts']));
  });

  it('rolls back the optimistic toggle when the POST fails', async () => {
    postFileViewedMock.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useFileViewState(REF, HEAD, {}));

    act(() => result.current.toggleViewed('a.ts'));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // The rejected POST reverts the optimistic add back to the server truth.
    await waitFor(() => expect(result.current.viewedPaths.has('a.ts')).toBe(false));
  });

  it('does not clobber a newer toggle when an older POST fails late', async () => {
    // Server says a.ts is viewed at HEAD.
    let rejectFirst!: (e: Error) => void;
    const firstPending = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    // POST_1 stays in flight; POST_2 and POST_3 resolve immediately.
    postFileViewedMock.mockReturnValueOnce(firstPending).mockResolvedValue(undefined);

    const { result } = renderHook(() => useFileViewState(REF, HEAD, { 'a.ts': HEAD }));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // Three rapid toggles of the same path. A render commits between acts, so
    // `desired` alternates: false (POST_1) -> true (POST_2) -> false (POST_3).
    act(() => result.current.toggleViewed('a.ts')); // POST_1: viewed=false (will fail late)
    act(() => result.current.toggleViewed('a.ts')); // POST_2: viewed=true
    act(() => result.current.toggleViewed('a.ts')); // POST_3: viewed=false (latest intent)
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);

    // POST_1 fails AFTER the newer toggles landed. Its rollback must not revert
    // the path to the stale server truth — the latest intent (not viewed) wins.
    await act(async () => {
      rejectFirst(new Error('late failure'));
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);
  });

  it('clears overrides when the head advances (key change resets viewed state)', () => {
    const { result, rerender } = renderHook(
      ({ head }: { head: string }) => useFileViewState(REF, head, {}),
      { initialProps: { head: HEAD } },
    );

    act(() => result.current.toggleViewed('a.ts'));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // A head advance makes prior-head marks stale; the overlay resets to 0.
    rerender({ head: 'newhead' });
    expect(result.current.viewedPaths).toEqual(new Set());
  });

  it('no-ops toggleViewed before the head sha is known', () => {
    const { result } = renderHook(() => useFileViewState(REF, undefined, undefined));

    act(() => result.current.toggleViewed('a.ts'));

    expect(result.current.viewedPaths).toEqual(new Set());
    expect(postFileViewedMock).not.toHaveBeenCalled();
  });
});
