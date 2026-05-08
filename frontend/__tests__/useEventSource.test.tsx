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
});
