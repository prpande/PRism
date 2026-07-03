import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';

const listeners: Record<string, ((p: unknown) => void)[]> = {};
const stableStream = {
  on: (type: string, cb: (p: unknown) => void) => {
    (listeners[type] ??= []).push(cb);
    return () => {
      listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb);
    };
  },
};
vi.mock('./useEventSource', () => ({ useEventSource: () => stableStream }));

import { useReviewThreadResolutionChangedSubscriber } from './useReviewThreadResolutionChangedSubscriber';

function fire(type: string, payload: unknown) {
  (listeners[type] ?? []).forEach((cb) => cb(payload));
}

describe('useReviewThreadResolutionChangedSubscriber', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it('calls onChanged for a matching prRef', async () => {
    const onChanged = vi.fn();
    renderHook(() =>
      useReviewThreadResolutionChangedSubscriber({
        prRef: { owner: 'o', repo: 'r', number: 1 },
        onChanged,
      }),
    );
    await waitFor(() =>
      expect(listeners['review-thread-resolution-changed']?.length).toBeGreaterThan(0),
    );
    act(() => fire('review-thread-resolution-changed', { prRef: 'o/r/1' }));
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores a different prRef', async () => {
    const onChanged = vi.fn();
    renderHook(() =>
      useReviewThreadResolutionChangedSubscriber({
        prRef: { owner: 'o', repo: 'r', number: 1 },
        onChanged,
      }),
    );
    await waitFor(() =>
      expect(listeners['review-thread-resolution-changed']?.length).toBeGreaterThan(0),
    );
    act(() => fire('review-thread-resolution-changed', { prRef: 'o/r/2' }));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
