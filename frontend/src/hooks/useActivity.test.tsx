import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ActivityResponse } from '../api/types';
import { useActivity } from './useActivity';

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
});

beforeEach(() => {
  getActivityMock.mockReset();
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
    await waitFor(() => expect(result.current.data?.items[0].prNumber).toBe(1));
    expect(getActivityMock).toHaveBeenCalledTimes(1);
  });
});
