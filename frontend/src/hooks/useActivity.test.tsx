import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ActivityResponse } from '../api/types';
import { useActivity, __resetActivityCacheForTests } from './useActivity';

const { getActivityMock } = vi.hoisted(() => ({ getActivityMock: vi.fn() }));
vi.mock('../api/activity', () => ({ getActivity: getActivityMock }));

const RESP = (n: number): ActivityResponse => ({
  items: [
    {
      actorLogin: 'alice',
      actorAvatarUrl: null,
      actorIsBot: false,
      verb: 'reviewed',
      repo: 'acme/api',
      prNumber: n,
      title: 'T',
      url: `https://github.com/acme/api/pull/${n}`,
      timestamp: new Date().toISOString(),
      source: 'received-event',
    },
  ],
  generatedAt: new Date().toISOString(),
  degraded: { receivedEvents: false, notifications: false, watching: false },
  watching: [],
  stale: false,
});

function setVisibility(state: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
}

// Flip visibilityState, then dispatch the visibilitychange event the hook's effect listens on.
function changeVisibilityTo(state: 'visible' | 'hidden') {
  setVisibility(state);
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

// Lets a test hold a poll in flight while the tab's visibility changes underneath it.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

// Drains the microtask queue so a queueMicrotask-scheduled refetch has run (or provably hasn't).
const flushMicrotasks = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

beforeEach(() => {
  getActivityMock.mockReset();
  // #359 — the last-good cache is module-scoped (persists across mounts by design);
  // clear it between cases so one test's fetched data doesn't seed the next.
  __resetActivityCacheForTests();
  // shouldAdvanceTime: true lets waitFor's internal setTimeout run in real-time
  // while vi.advanceTimersByTimeAsync still drives the poll interval forward.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
  // The visibility cases mutate a shared `document`; without this restore the next case
  // in this file would inherit 'hidden' instead of jsdom's 'visible' default.
  setVisibility('visible');
});

describe('useActivity', () => {
  test('loads, then polls on the cadence', async () => {
    getActivityMock.mockResolvedValueOnce(RESP(1)).mockResolvedValueOnce(RESP(2));
    const { result } = renderHook(() => useActivity());

    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(2));
    expect(getActivityMock).toHaveBeenCalledTimes(2);
  });

  test('retains last-good data when a poll fails', async () => {
    getActivityMock.mockResolvedValueOnce(RESP(1)).mockRejectedValueOnce(new Error('blip'));
    const { result } = renderHook(() => useActivity());

    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });

    // Last-good data preserved; error surfaced.
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data?.items[0].prNumber).toBe(1);
  });

  // #507 — the hook is now hoisted into InboxPage and called unconditionally with an
  // `enabled` flag, so the no-fetch-when-hidden guarantee (#300/#283) lives here, on the
  // flag, rather than on whether the rail mounts.
  test('disabled: never fetches and settles to a not-loading idle state', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity(false));

    // No request fires, even after a full poll interval elapses.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(getActivityMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  test('enabling after being disabled starts the fetch', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result, rerender } = renderHook(({ on }) => useActivity(on), {
      initialProps: { on: false },
    });
    expect(getActivityMock).not.toHaveBeenCalled();

    rerender({ on: true });
    // Enabling enters the loading state (skeleton-before-data) when nothing is cached,
    // before the first response lands — documents the enable→loading contract.
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);
  });

  // #359 — stale-while-revalidate across unmount/remount (navigate away and back).
  test('seeds last-good from the module cache on remount — no skeleton — then revalidates in place', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const first = renderHook(() => useActivity());
    await waitFor(() => expect(first.result.current.data?.items[0].prNumber).toBe(1));
    first.unmount(); // navigate away from the inbox

    // Navigate back: the next response differs, but the rail must NOT flash a skeleton.
    getActivityMock.mockResolvedValue(RESP(2));
    const second = renderHook(() => useActivity());
    // Immediately on remount: last-good (1) is shown, isLoading is false (no skeleton).
    expect(second.result.current.data?.items[0].prNumber).toBe(1);
    expect(second.result.current.isLoading).toBe(false);

    // ...and it revalidates in place, swapping to the fresh response.
    await waitFor(() => expect(second.result.current.data?.items[0].prNumber).toBe(2));
  });

  // The skeleton must still appear on the genuine first load, when nothing is cached.
  test('first load (empty cache) starts in the loading state', () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
  });

  // #619 — stale feed: the backend seeds an expired TTL and returns stale:true so the
  // immediate refetch (via queueMicrotask) is a real GitHub read, not a no-op cache hit.
  test('immediately refetches when the response is stale', async () => {
    getActivityMock
      .mockResolvedValueOnce({ ...RESP(1), stale: true })
      .mockResolvedValueOnce({ ...RESP(2), stale: false });
    const { result } = renderHook(() => useActivity());
    // Resolves to prNumber 2 WITHOUT advancing the 90s timer — the refetch was triggered
    // by the stale flag, not the poll interval.
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(2));
    expect(getActivityMock).toHaveBeenCalledTimes(2);
  });
});

// #732 — /api/activity is a real 3-call GitHub fan-out, so a backgrounded tab must not poll it.
describe('useActivity — visibility gate (#732)', () => {
  test('pauses the poll while the tab is hidden', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    changeVisibilityTo('hidden');

    // Three full cadences elapse with the tab hidden: the interval is paused, not skipped.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3 * 90_000);
    });
    expect(getActivityMock).toHaveBeenCalledTimes(1);
  });

  test('fires exactly one catch-up poll on return to visible, without waiting for the tick', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity());
    await waitFor(() => expect(result.current.data).not.toBeNull());

    changeVisibilityTo('hidden');
    changeVisibilityTo('visible');

    await waitFor(() => expect(getActivityMock).toHaveBeenCalledTimes(2));
    await flushMicrotasks();
    expect(getActivityMock).toHaveBeenCalledTimes(2);
  });

  // Browsers emit 'visible' on some focus/blur cycles with no intervening 'hidden'. Keying the
  // catch-up off `id === undefined` makes those a no-op; a `wasHidden` boolean would not.
  test('a redundant visible event with no intervening hidden fires no extra poll', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity());
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    changeVisibilityTo('visible');

    await flushMicrotasks();
    expect(getActivityMock).toHaveBeenCalledTimes(1);
  });

  test('mounting while hidden fetches nothing and holds the skeleton until first foreground', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    setVisibility('hidden');
    const { result } = renderHook(() => useActivity());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(getActivityMock).not.toHaveBeenCalled();
    // isLoading settles only in poll()'s finally, and poll() never ran.
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();

    changeVisibilityTo('visible');

    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);
  });

  // The `enabled` gate dominates: a disabled rail arms no interval AND registers no listener.
  test('disabled: visibility events fetch nothing and isLoading stays settled', async () => {
    getActivityMock.mockResolvedValue(RESP(1));
    const { result } = renderHook(() => useActivity(false));

    changeVisibilityTo('hidden');
    changeVisibilityTo('visible');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(getActivityMock).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  // The resume response is stale:true on purpose. With a fresh resume response this case would
  // pass vacuously — only a stale one makes a reset-on-resume implementation observable, as a
  // 4th call where the correct implementation makes exactly 3.
  test('a visibility resume does not re-arm the #619 stale-refetch one-shot', async () => {
    getActivityMock.mockResolvedValue({ ...RESP(1), stale: true });
    renderHook(() => useActivity());

    // mount poll (1) is stale -> one nudge (2); the one-shot is now spent.
    await waitFor(() => expect(getActivityMock).toHaveBeenCalledTimes(2));

    changeVisibilityTo('hidden');
    changeVisibilityTo('visible');

    // resume poll (3) is also stale, but the one-shot must not fire a 4th.
    await waitFor(() => expect(getActivityMock).toHaveBeenCalledTimes(3));
    await flushMicrotasks();
    expect(getActivityMock).toHaveBeenCalledTimes(3);
  });

  // stop() clears the interval but cannot cancel an in-flight request. When that request lands
  // stale:true on a now-hidden tab, the #619 microtask would otherwise fire a real GitHub read.
  test('a stale response landing after the tab hides does not fire the #619 nudge', async () => {
    const pending = deferred<ActivityResponse>();
    getActivityMock
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ ...RESP(2), stale: false });
    renderHook(() => useActivity());
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    changeVisibilityTo('hidden');

    await act(async () => {
      pending.resolve({ ...RESP(1), stale: true });
      await pending.promise;
    });
    await flushMicrotasks();
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    changeVisibilityTo('visible');
    await waitFor(() => expect(getActivityMock).toHaveBeenCalledTimes(2));
  });

  // A hide/show cycle during a slow mount fetch would otherwise dispatch a second concurrent
  // poll (id === undefined), letting an out-of-order response clobber the newer one.
  test('a resume while a poll is in flight starts no second request (single-flight)', async () => {
    const pending = deferred<ActivityResponse>();
    getActivityMock.mockReturnValueOnce(pending.promise).mockResolvedValue(RESP(2));
    const { result } = renderHook(() => useActivity());
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    changeVisibilityTo('hidden');
    changeVisibilityTo('visible');

    await flushMicrotasks();
    expect(getActivityMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      pending.resolve(RESP(1));
      await pending.promise;
    });
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);
  });
});
