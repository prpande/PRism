import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
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
  }
  dispatch(type: string, data: unknown) {
    this.listeners[type]?.forEach((cb) => cb({ data: JSON.stringify(data) } as MessageEvent));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

describe('useInboxUpdates', () => {
  it('shows banner on inbox-updated event', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(result.current.hasUpdate).toBe(false);
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: ['awaiting-author'],
        newOrUpdatedPrCount: 3,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    expect(result.current.summary).toContain('3 new updates');
  });

  it('dismiss clears banner', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.summary).toBe('');
  });

  it('uses singular form when newOrUpdatedPrCount is 1', async () => {
    const { result } = renderHook(() => useInboxUpdates(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('inbox-updated', {
        changedSectionIds: [],
        newOrUpdatedPrCount: 1,
      }),
    );
    await waitFor(() => expect(result.current.hasUpdate).toBe(true));
    expect(result.current.summary).toBe('1 new update');
  });
});
