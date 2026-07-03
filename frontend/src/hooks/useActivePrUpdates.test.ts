import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useActivePrUpdates } from './useActivePrUpdates';
import type { PrReference } from '../api/types';

const listeners: Record<string, ((p: unknown) => void)[]> = {};
// A STABLE stream handle: useActivePrUpdates' effect depends on [stream, refStr]. A fresh object
// per render would re-run the effect, which calls setState(initial) and would wipe the latched
// readiness right after a fired event. Returning one identity keeps the subscription stable.
const stableStream = {
  on: (type: string, cb: (p: unknown) => void) => {
    (listeners[type] ??= []).push(cb);
    return () => {
      listeners[type] = (listeners[type] ?? []).filter((c) => c !== cb);
    };
  },
  subscriberId: () => Promise.resolve('test'),
  reconnectSignal: () => new AbortController().signal,
  close: () => {},
};
vi.mock('./useEventSource', () => ({
  useEventSource: () => stableStream,
}));

vi.mock('../api/client', () => ({
  apiClient: {
    post: () => Promise.resolve({}),
    delete: () => Promise.resolve({}),
  },
}));

function fireSse(type: string, payload: unknown) {
  (listeners[type] ?? []).forEach((cb) => cb(payload));
}

describe('useActivePrUpdates', () => {
  beforeEach(() => {
    for (const k of Object.keys(listeners)) delete listeners[k];
  });

  it('surfaces mergeReadiness when a pr-updated event latches it', async () => {
    const { result } = renderHook(() =>
      useActivePrUpdates({ owner: 'acme', repo: 'api', number: 1 }),
    );

    // Let the subscribe effect register the pr-updated listener.
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        mergeReadinessChanged: true,
        mergeReadiness: 'ready',
      });
    });

    expect(result.current.mergeReadiness).toBe('ready');
  });

  it('keeps the last readiness when a later event has mergeReadinessChanged=false (anti-flicker latch)', async () => {
    const { result } = renderHook(() =>
      useActivePrUpdates({ owner: 'acme', repo: 'api', number: 1 }),
    );
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        mergeReadinessChanged: true,
        mergeReadiness: 'ready',
      });
    });
    expect(result.current.mergeReadiness).toBe('ready');

    // A transient None tick carries mergeReadinessChanged=false → the latch keeps 'ready'.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: true,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        mergeReadinessChanged: false,
        mergeReadiness: 'none',
      });
    });
    expect(result.current.mergeReadiness).toBe('ready');
  });

  it('clears reviewer lists when a later event sends null (snapshot, not ??) — #621', async () => {
    const { result } = renderHook(() =>
      useActivePrUpdates({ owner: 'acme', repo: 'api', number: 1 }),
    );
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    // First tick: an approver is present.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        approvals: 1,
        approvers: [{ login: 'octocat', avatarUrl: null }],
      });
    });
    expect(result.current.approvers).toEqual([{ login: 'octocat', avatarUrl: null }]);
    expect(result.current.approvals).toBe(1);

    // Second tick: the approval was dismissed — the wire sends null to CLEAR the category.
    // With `??` the stale approver would persist; snapshot() takes the explicit null.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        approvals: null,
        approvers: null,
      });
    });
    expect(result.current.approvers).toBeNull();
    expect(result.current.approvals).toBeNull();
  });

  it('keeps the prior reviewer list when a later event omits the field (undefined ≠ clear)', async () => {
    const { result } = renderHook(() =>
      useActivePrUpdates({ owner: 'acme', repo: 'api', number: 1 }),
    );
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
        approvers: [{ login: 'octocat', avatarUrl: null }],
      });
    });

    // A reduced event (e.g. a head-only tick / older fixture) that doesn't carry approvers
    // must NOT wipe the list — undefined means "no update", distinct from a null clear.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: true,
        baseShaChanged: false,
        commentCountDelta: 0,
        isMerged: false,
        isClosed: false,
      });
    });
    expect(result.current.approvers).toEqual([{ login: 'octocat', avatarUrl: null }]);
  });

  it('#620 — bumps prUpdatedSignal on every pr-updated frame, even with NO mergeability change (regression guard)', async () => {
    const { result } = renderHook(() =>
      useActivePrUpdates({ owner: 'acme', repo: 'api', number: 1 }),
    );
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    expect(result.current.prUpdatedSignal).toBe(0);

    // A bare-comment / review-request / approval frame: mergeReadinessChanged=false,
    // no mergeReadiness field at all. If the counter were bumped from inside the
    // mergeReadinessChanged branch instead of unconditionally, this frame would
    // never advance it — silently defeating ActivityFeed's live-refresh.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 1,
        isMerged: false,
        isClosed: false,
        mergeReadinessChanged: false,
      });
    });
    expect(result.current.prUpdatedSignal).toBe(1);
    expect(result.current.mergeReadiness).toBeUndefined();

    // A second, unrelated frame bumps it again.
    act(() => {
      fireSse('pr-updated', {
        prRef: 'acme/api/1',
        headShaChanged: false,
        baseShaChanged: false,
        commentCountDelta: 1,
        isMerged: false,
        isClosed: false,
        mergeReadinessChanged: false,
      });
    });
    expect(result.current.prUpdatedSignal).toBe(2);
  });

  it('#671 — clear() keeps a stable identity across re-renders so memoized consumers can bail out', async () => {
    // clear lives in usePrDetailRefresh's `refresh` useCallback dep array (via
    // PrDetailView's `clearUpdates`). A fresh arrow per render re-created `refresh`
    // every render — useCallback pins it. A bare re-render (same ref, no SSE event, so
    // no state change) must return the same clear reference.
    const ref: PrReference = { owner: 'acme', repo: 'api', number: 1 };
    const { result, rerender } = renderHook(() => useActivePrUpdates(ref));
    await waitFor(() => expect(listeners['pr-updated']?.length).toBeGreaterThan(0));

    const first = result.current.clear;
    rerender();
    expect(result.current.clear).toBe(first);
  });
});
