import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';

class FakeEventSource {
  static instance: FakeEventSource;
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  constructor() {
    FakeEventSource.instance = this;
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
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
});

describe('useInboxUpdates', () => {
  it('shows banner on inbox-updated event', async () => {
    const { result } = renderHook(() => useInboxUpdates());
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
    const { result } = renderHook(() => useInboxUpdates());
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
});
