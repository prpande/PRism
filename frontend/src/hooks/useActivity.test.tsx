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
});
