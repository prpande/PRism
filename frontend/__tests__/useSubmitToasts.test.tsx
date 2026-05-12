import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubmitToasts } from '../src/hooks/useSubmitToasts';
import type { PrReference } from '../src/api/types';

// Mirror the real useEventSource() → EventStreamHandle.on(type, cb) → unsubscribe
// contract (R4); fire events via `emit`. Don't mock the hook under test.
type Handler = (p: unknown) => void;
const handlers: Record<string, Set<Handler>> = {};
function emit(type: string, payload: unknown) {
  handlers[type]?.forEach((h) => h(payload));
}
vi.mock('../src/hooks/useEventSource', () => ({
  useEventSource: () => ({
    subscriberId: () => Promise.resolve('s1'),
    reconnectSignal: () => new AbortController().signal,
    on: (type: string, cb: Handler) => {
      (handlers[type] ??= new Set()).add(cb);
      return () => handlers[type]?.delete(cb);
    },
    close: () => {},
  }),
}));

const ref: PrReference = { owner: 'o', repo: 'r', number: 1 };

beforeEach(() => {
  for (const k of Object.keys(handlers)) delete handlers[k];
});

describe('useSubmitToasts', () => {
  it('submit-duplicate-marker-detected fires a toast naming the draftId', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts(ref, { showToast: (m) => toasts.push(m) }));
    act(() => emit('submit-duplicate-marker-detected', { prRef: 'o/r/1', draftId: 'd1' }));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/duplicate/i);
    expect(toasts[0]).toMatch(/d1/);
  });

  it('submit-orphan-cleanup-failed fires the orphan-cleanup toast', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts(ref, { showToast: (m) => toasts.push(m) }));
    act(() => emit('submit-orphan-cleanup-failed', { prRef: 'o/r/1' }));
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatch(/local drafts cleared/i);
    expect(toasts[0]).toMatch(/may persist/i);
  });

  it('ignores submit-* events for a different prRef (multi-tab fanout guard)', () => {
    const toasts: string[] = [];
    renderHook(() => useSubmitToasts(ref, { showToast: (m) => toasts.push(m) }));
    act(() => emit('submit-orphan-cleanup-failed', { prRef: 'o/r/2' }));
    act(() => emit('submit-duplicate-marker-detected', { prRef: 'o/r/2', draftId: 'd9' }));
    expect(toasts).toHaveLength(0);
  });

  it('unsubscribes on unmount', () => {
    const toasts: string[] = [];
    const { unmount } = renderHook(() =>
      useSubmitToasts(ref, { showToast: (m) => toasts.push(m) }),
    );
    unmount();
    act(() => emit('submit-orphan-cleanup-failed', { prRef: 'o/r/1' }));
    expect(toasts).toHaveLength(0);
  });

  it('uses the latest showToast without re-subscribing', () => {
    const first: string[] = [];
    const second: string[] = [];
    const { rerender } = renderHook(({ sink }: { sink: string[] }) =>
      useSubmitToasts(ref, { showToast: (m) => sink.push(m) }),
      { initialProps: { sink: first } },
    );
    rerender({ sink: second });
    act(() => emit('submit-orphan-cleanup-failed', { prRef: 'o/r/1' }));
    expect(first).toHaveLength(0);
    expect(second).toHaveLength(1);
  });
});
