import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { useInboxUpdates } from '../src/hooks/useInboxUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

const emit = () =>
  FakeEventSource.instance.dispatch('inbox-updated', {
    changedSectionIds: [],
    newOrUpdatedPrCount: 1,
  });

beforeEach(() => {
  installFakeEventSource();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useInboxUpdates (auto-refresh)', () => {
  it('calls onUpdate once after the debounce window', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => emit());
    expect(onUpdate).not.toHaveBeenCalled(); // debounced, not yet fired
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one onUpdate', async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => {
      emit();
      emit();
      emit();
    });
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);
  });

  it('queues exactly one trailing reload when an event lands mid-flight', async () => {
    let resolveFirst!: () => void;
    const onUpdate = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (resolveFirst = r)))
      .mockResolvedValue(undefined);
    renderHook(() => useInboxUpdates({ onUpdate }), { wrapper });
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // First reload starts (and hangs).
    act(() => emit());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // Event arrives while the first reload is still in flight → queued, not stacked.
    act(() => emit());
    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(onUpdate).toHaveBeenCalledTimes(1); // still 1 — queued behind the in-flight one

    // First reload resolves → exactly one trailing reload fires.
    await act(async () => {
      resolveFirst();
    });
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
