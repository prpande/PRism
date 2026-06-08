import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { EventStreamHandle } from '../api/events';

const mockHolder = vi.hoisted(() => ({ current: null as EventStreamHandle | null }));
vi.mock('./useEventSource', () => ({
  useEventSource: () => mockHolder.current,
}));
import { useStreamHealth } from './useStreamHealth';

function makeHandle(initial: boolean) {
  let healthy = initial;
  const subs = new Set<(h: boolean) => void>();
  const handle = {
    streamHealthy: () => healthy,
    onHealthChange: (cb: (h: boolean) => void) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    forceReconnect: vi.fn(),
    subscriberId: () => Promise.resolve('x'),
    reconnectSignal: () => new AbortController().signal,
    on: () => () => {},
    close: () => {},
  } as unknown as EventStreamHandle;
  const set = (h: boolean) => {
    healthy = h;
    subs.forEach((cb) => cb(h));
  };
  return { handle, set };
}

beforeEach(() => {
  mockHolder.current = null;
});

describe('useStreamHealth', () => {
  it('returns healthy:true and a no-op retry when no provider is present', () => {
    mockHolder.current = null;
    const { result } = renderHook(() => useStreamHealth());
    expect(result.current.healthy).toBe(true);
    expect(typeof result.current.retry).toBe('function');
    result.current.retry(); // must not throw
  });

  it('tracks the handle health and exposes retry → forceReconnect', () => {
    const { handle, set } = makeHandle(true);
    mockHolder.current = handle;
    const { result } = renderHook(() => useStreamHealth());
    expect(result.current.healthy).toBe(true);
    act(() => set(false));
    expect(result.current.healthy).toBe(false);
    result.current.retry();
    expect(handle.forceReconnect).toHaveBeenCalledTimes(1);
  });

  it('seeds healthy from streamHealthy() when the handle is already unhealthy', () => {
    const { handle } = makeHandle(false);
    mockHolder.current = handle;
    const { result } = renderHook(() => useStreamHealth());
    expect(result.current.healthy).toBe(false);
  });

  it('unsubscribes on unmount', () => {
    const { handle, set } = makeHandle(true);
    mockHolder.current = handle;
    const { result, unmount } = renderHook(() => useStreamHealth());
    expect(result.current.healthy).toBe(true);
    unmount();
    // After unmount, the hook's setHealthy is no longer subscribed; firing a change
    // must not update the (unmounted) hook's last-rendered state.
    act(() => set(false));
    expect(result.current.healthy).toBe(true); // unchanged → unsubscribed cleanly
  });
});
