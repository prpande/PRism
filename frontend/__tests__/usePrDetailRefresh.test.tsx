import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePrDetailRefresh } from '../src/hooks/usePrDetailRefresh';
import * as prDetailApi from '../src/api/prDetail';

const PR = { owner: 'o', repo: 'r', number: 7 };

describe('usePrDetailRefresh', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('on success: posts refresh, reloads, clears updates, announces, morphs', async () => {
    const refreshSpy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);
    const reload = vi.fn();
    const clearUpdates = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates, onError }),
    );

    await act(async () => {
      await result.current.refresh();
    });

    expect(refreshSpy).toHaveBeenCalledWith(PR, expect.any(AbortSignal));
    expect(reload).toHaveBeenCalledTimes(1);
    expect(clearUpdates).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.justRefreshed).toBe(true);
    expect(result.current.announce).toBe('PR refreshed');
  });

  it('on failure: announces nothing, calls onError, does not morph', async () => {
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockRejectedValue(new Error('503'));
    const reload = vi.fn();
    const clearUpdates = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates, onError }),
    );
    await act(async () => {
      await result.current.refresh();
    });

    expect(reload).not.toHaveBeenCalled();
    expect(clearUpdates).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("Couldn't refresh this PR. Try again.");
    expect(result.current.justRefreshed).toBe(false);
  });

  it('re-entrancy: a second call while in-flight is ignored', async () => {
    let resolveFirst: () => void = () => {};
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveFirst = res;
        }),
    );
    const reload = vi.fn();
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload, clearUpdates: vi.fn(), onError: vi.fn() }),
    );

    let p1!: Promise<void>;
    act(() => {
      p1 = result.current.refresh();
    });
    await act(async () => {
      await result.current.refresh();
    }); // ignored (in-flight)
    expect(prDetailApi.refreshPrDetail).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveFirst();
      await p1;
    });
  });

  it('min-interval: a second call within the success window is ignored', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(prDetailApi, 'refreshPrDetail').mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload: vi.fn(), clearUpdates: vi.fn(), onError: vi.fn() }),
    );
    await act(async () => {
      await result.current.refresh();
    });
    await act(async () => {
      await result.current.refresh();
    }); // within MIN_INTERVAL_MS → ignored
    expect(spy).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('timeout: aborts after TIMEOUT_MS and calls onError', async () => {
    vi.useFakeTimers();
    // Reject when the hook's AbortController fires (mirrors fetch's abort behavior).
    vi.spyOn(prDetailApi, 'refreshPrDetail').mockImplementation(
      (_pr, signal) =>
        new Promise<void>((_, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePrDetailRefresh({ prRef: PR, reload: vi.fn(), clearUpdates: vi.fn(), onError }),
    );

    let p!: Promise<void>;
    act(() => {
      p = result.current.refresh();
    });
    await act(async () => {
      vi.advanceTimersByTime(30_000); // past TIMEOUT_MS → controller.abort() → mock rejects
      await p;
    });

    expect(onError).toHaveBeenCalledWith("Couldn't refresh this PR. Try again.");
    expect(result.current.isRefreshing).toBe(false);
    vi.useRealTimers();
  });
});
