import { renderHook, act, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useReconcile } from '../src/hooks/useReconcile';
import * as draftApi from '../src/api/draft';
import { __resetTabIdForTest } from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'acme', repo: 'api', number: 123 };
const sha1 = 'a'.repeat(40);
const sha2 = 'b'.repeat(40);

beforeEach(() => {
  __resetTabIdForTest();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useReconcile', () => {
  it('Reload_HappyPath_UpdatesSession', async () => {
    const post = vi.spyOn(draftApi, 'postReload').mockResolvedValue({ ok: true });
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    await act(async () => {
      await result.current.reload();
    });

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenNthCalledWith(1, ref, sha1, expect.any(AbortSignal));
    expect(onReloadComplete).toHaveBeenCalledTimes(1);
    expect(result.current.banner).toBeNull();
    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('Reload_409StaleHead_AutoRetriesOnce_WithCurrentHeadSha', async () => {
    const post = vi
      .spyOn(draftApi, 'postReload')
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        kind: 'reload-stale-head',
        body: { error: 'reload-stale-head', currentHeadSha: sha2 },
      })
      .mockResolvedValueOnce({ ok: true });
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    await act(async () => {
      await result.current.reload();
    });

    expect(post).toHaveBeenCalledTimes(2);
    // First call with the stale headSha.
    expect(post).toHaveBeenNthCalledWith(1, ref, sha1, expect.any(AbortSignal));
    // Auto-retry: second call with the currentHeadSha from the 409 body.
    expect(post).toHaveBeenNthCalledWith(2, ref, sha2, expect.any(AbortSignal));
    expect(onReloadComplete).toHaveBeenCalledTimes(1);
    expect(result.current.banner).toBeNull();
  });

  it('Reload_TwoConsecutive409StaleHead_StopsRetrying_SurfacesBanner', async () => {
    const post = vi
      .spyOn(draftApi, 'postReload')
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        kind: 'reload-stale-head',
        body: { error: 'reload-stale-head', currentHeadSha: sha2 },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        kind: 'reload-stale-head',
        body: { error: 'reload-stale-head', currentHeadSha: 'c'.repeat(40) },
      });
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    await act(async () => {
      await result.current.reload();
    });

    // Exactly two calls — no third retry.
    expect(post).toHaveBeenCalledTimes(2);
    expect(onReloadComplete).not.toHaveBeenCalled();
    expect(result.current.banner).toMatch(/head shifted/i);
    expect(result.current.state).toBe('error');
  });

  it('Reload_409InProgress_NoRetry_SurfacesBanner', async () => {
    const post = vi.spyOn(draftApi, 'postReload').mockResolvedValue({
      ok: false,
      status: 409,
      kind: 'reload-in-progress',
      body: { error: 'reload-in-progress' },
    });
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    await act(async () => {
      await result.current.reload();
    });

    // Single call — in-progress is NOT auto-retried.
    expect(post).toHaveBeenCalledTimes(1);
    expect(onReloadComplete).not.toHaveBeenCalled();
    expect(result.current.banner).toMatch(/already in progress/i);
    expect(result.current.state).toBe('error');
  });

  it('reload no-op when headSha is null', async () => {
    const post = vi.spyOn(draftApi, 'postReload');
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: null, onReloadComplete }),
    );

    await act(async () => {
      await result.current.reload();
    });

    expect(post).not.toHaveBeenCalled();
    expect(onReloadComplete).not.toHaveBeenCalled();
    // No banner — silently skips because the active-PR cache hasn't reported
    // a head yet. The Reload button is gated by upstream UI anyway.
    expect(result.current.banner).toBeNull();
  });

  it('Reload_DoubleClick_FiresOnlyOnePost (re-entrancy guard; late resolver cannot clobber)', async () => {
    let resolveFirst: (v: draftApi.PostReloadResult) => void = () => {};
    const post = vi
      .spyOn(draftApi, 'postReload')
      .mockImplementationOnce(
        () => new Promise<draftApi.PostReloadResult>((resolve) => (resolveFirst = resolve)),
      );
    const onReloadComplete = vi.fn();

    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    // Two rapid clicks while the first POST is still in flight.
    let p1!: Promise<void>;
    let p2!: Promise<void>;
    act(() => {
      p1 = result.current.reload();
      p2 = result.current.reload();
    });

    // The second click is swallowed by the in-flight guard — only one POST.
    expect(post).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveFirst({ ok: true });
      await Promise.all([p1, p2]);
    });

    // The single in-flight reload completed exactly once.
    expect(post).toHaveBeenCalledTimes(1);
    expect(onReloadComplete).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.state).toBe('idle'));
  });

  it('Reload_UnmountMidFlight_NoStateUpdate_NoComplete (mounted guard)', async () => {
    let resolveFirst: (v: draftApi.PostReloadResult) => void = () => {};
    vi.spyOn(draftApi, 'postReload').mockImplementationOnce(
      () => new Promise<draftApi.PostReloadResult>((resolve) => (resolveFirst = resolve)),
    );
    const onReloadComplete = vi.fn();
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result, unmount } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
    );

    act(() => {
      void result.current.reload();
    });
    unmount();

    await act(async () => {
      resolveFirst({ ok: true });
      // flush microtasks so the post-await continuation runs against the
      // unmounted hook.
      await Promise.resolve();
      await Promise.resolve();
    });

    // The completion callback must NOT fire against a torn-down view, and no
    // setState-after-unmount warning is emitted.
    expect(onReloadComplete).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("Can't perform a React state update"),
      expect.anything(),
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('Reload_HungFetch_AbortsAfterTimeout_SurfacesGenericBanner', async () => {
    vi.useFakeTimers();
    try {
      // postReload that only resolves when its AbortSignal fires (a hung fetch).
      vi.spyOn(draftApi, 'postReload').mockImplementation(
        (_ref, _sha, signal?: AbortSignal) =>
          new Promise<draftApi.PostReloadResult>((resolve) => {
            signal?.addEventListener('abort', () =>
              resolve({ ok: false, status: 0, kind: 'network', body: 'aborted' }),
            );
          }),
      );
      const onReloadComplete = vi.fn();

      const { result } = renderHook(() =>
        useReconcile({ prRef: ref, headSha: sha1, onReloadComplete }),
      );

      let reloadPromise!: Promise<void>;
      act(() => {
        reloadPromise = result.current.reload();
      });
      expect(result.current.state).toBe('reloading');

      // Advance past the 30s timeout — the controller aborts, postReload resolves
      // with a network result, and the hook surfaces the generic banner.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
        await reloadPromise;
      });

      expect(onReloadComplete).not.toHaveBeenCalled();
      expect(result.current.state).toBe('error');
      expect(result.current.banner).toMatch(/try again/i);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clearBanner resets the banner to null', async () => {
    vi.spyOn(draftApi, 'postReload').mockResolvedValue({
      ok: false,
      status: 409,
      kind: 'reload-in-progress',
      body: { error: 'reload-in-progress' },
    });
    const { result } = renderHook(() =>
      useReconcile({ prRef: ref, headSha: sha1, onReloadComplete: vi.fn() }),
    );

    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.banner).not.toBeNull();

    act(() => result.current.clearBanner());
    expect(result.current.banner).toBeNull();
    expect(result.current.state).toBe('idle');
  });
});
