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

  // #600 Bug B — a failed POST must restore the PRIOR value, not a snapshot of
  // server state captured before an earlier success. mark-ok then unmark-fail:
  // the server still holds `viewed:true` (the unmark never landed), so the UI
  // must stay viewed rather than reverting to the stale `serverViewed` ({}).
  it('restores the last acked value when a later POST fails (mark-ok then unmark-fail)', async () => {
    // First POST (mark) succeeds; second POST (unmark) fails.
    postFileViewedMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useFileViewState(REF, HEAD, {}));

    // Mark a.ts viewed — POST succeeds, so the server now holds viewed:true.
    act(() => result.current.toggleViewed('a.ts'));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // Unmark a.ts — this POST fails. Rolling back must fall back to the acked
    // value (viewed), NOT the stale serverViewed snapshot ({} → not-viewed).
    act(() => result.current.toggleViewed('a.ts'));
    expect(result.current.viewedPaths.has('a.ts')).toBe(false); // optimistic
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(true); // restored to server truth
  });

  // #600 Bug A — once a POST succeeds, the override must not shadow newer server
  // truth. A refetch that the server has caught up to evicts the override, so a
  // later refetch dropping the path (un-viewed elsewhere) is honored.
  it('does not shadow a server refetch that drops the path after a successful POST', async () => {
    const { result, rerender } = renderHook(
      ({ persisted }: { persisted: Record<string, string> }) =>
        useFileViewState(REF, HEAD, persisted),
      { initialProps: { persisted: {} as Record<string, string> } },
    );

    // Mark a.ts viewed; POST succeeds.
    act(() => result.current.toggleViewed('a.ts'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // A refetch reflects the server catching up (a.ts viewed at HEAD).
    rerender({ persisted: { 'a.ts': HEAD } });
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // a.ts is un-viewed elsewhere; the next refetch drops it. Server truth must
    // win — the optimistic override must not pin a.ts viewed indefinitely.
    rerender({ persisted: {} });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);
  });

  // #600 Bug A (symmetry) — eviction-on-agree is value-agnostic: an un-view
  // (confirmed:false) is evicted once the server snapshot drops the path, so a
  // later external re-mark is honored rather than shadowed by the stale un-view.
  it('evicts an un-view once the server agrees, then honors a later external re-mark', async () => {
    const { result, rerender } = renderHook(
      ({ persisted }: { persisted: Record<string, string> }) =>
        useFileViewState(REF, HEAD, persisted),
      { initialProps: { persisted: { 'a.ts': HEAD } as Record<string, string> } },
    );
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // Un-mark a.ts; POST succeeds → confirmed{a.ts:false} bridges the un-view.
    act(() => result.current.toggleViewed('a.ts'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);

    // A refetch reflects the server dropping a.ts → the un-view is evicted.
    rerender({ persisted: {} });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);

    // a.ts is re-marked elsewhere; the next refetch must win (no stale shadow).
    rerender({ persisted: { 'a.ts': HEAD } });
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);
  });

  // #600 (head-advance race) — an in-flight POST that ACKs AFTER the head
  // advances must scope its confirmed write to the toggle-time head, never leak
  // the mark into the new head (where the server never stamped it).
  it('does not leak a confirmed mark into a new head when an in-flight POST acks after a head advance', async () => {
    let resolveFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    postFileViewedMock.mockReturnValueOnce(firstPending);

    const { result, rerender } = renderHook(
      ({ head }: { head: string }) => useFileViewState(REF, head, {}),
      { initialProps: { head: HEAD } },
    );

    // Toggle at HEAD; the POST stays in flight.
    act(() => result.current.toggleViewed('a.ts'));
    expect(result.current.viewedPaths.has('a.ts')).toBe(true);

    // Head advances before the POST resolves — the overlay is key-scoped to HEAD.
    rerender({ head: 'newhead' });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);

    // The in-flight POST (stamped at HEAD) now succeeds. Its confirmed write is
    // scoped to HEAD and must not surface a.ts as viewed at the new head.
    await act(async () => {
      resolveFirst();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.viewedPaths.has('a.ts')).toBe(false);
  });
});
