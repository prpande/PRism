import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { EventStreamProvider, useEventSource } from '../src/hooks/useEventSource';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
  static CLOSED = 2;
  readyState = 0;
  onerror: ((e: Event) => void) | null = null;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, cb: (e: MessageEvent) => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
  dispatchRaw(type: string, raw: string) {
    this.listeners[type]?.forEach((cb) => cb({ data: raw } as MessageEvent));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  vi.restoreAllMocks();
});

describe('useEventSource / EventStreamProvider', () => {
  it('provides a non-null handle to children inside Provider', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    const { result } = renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(typeof result.current?.subscriberId).toBe('function');
  });

  it('returns null when used outside Provider', () => {
    const { result } = renderHook(() => useEventSource());
    expect(result.current).toBeNull();
  });

  it('closes the EventSource when Provider unmounts', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    const { unmount } = renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('only opens one EventSource regardless of how many consumers read context', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(
      () => {
        useEventSource();
        useEventSource();
        useEventSource();
        return null;
      },
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('dispatches prism-identity-changed on a well-formed identity-changed SSE frame', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const spy = vi.fn();
    window.addEventListener('prism-identity-changed', spy);
    try {
      FakeEventSource.instance.dispatch('identity-changed', { type: 'identity-change' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('prism-identity-changed', spy);
    }
  });

  it('does NOT dispatch the bridge window event when the payload is malformed JSON', async () => {
    // Regression: pre-fix, the bridge dispatch ran AFTER the try/catch and fired
    // even when JSON.parse failed — a garbled identity-changed frame would
    // trigger an unwanted useAuth refetch. The fix gates the dispatch on a
    // `parsed` flag inside the try block.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const spy = vi.fn();
    window.addEventListener('prism-identity-changed', spy);
    try {
      FakeEventSource.instance.dispatchRaw('identity-changed', '{not valid json');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('prism-identity-changed', spy);
    }
  });

  // Reconnect-replay defense (spec § 3.2.1) — the prism-events-reconnected
  // dispatch from reconnect() is intentionally NOT unit-tested here. Driving
  // the watchdog under jsdom's fake timers races against EventStreamProvider's
  // useEffect mount; the integration coverage lives in hooks.test.tsx (useAuth
  // refetches on prism-events-reconnected) and the dispatch is a one-liner
  // alongside the verified bridge structure above.
});
