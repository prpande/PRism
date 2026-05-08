import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { useActivePrUpdates } from '../src/hooks/useActivePrUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const refStr = 'octocat/hello/42';

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  static get instance(): FakeEventSource {
    return FakeEventSource.instances[FakeEventSource.instances.length - 1]!;
  }
  listeners: Record<string, ((e: MessageEvent) => void)[]> = {};
  closed = false;
  url: string;
  onerror: ((e: Event) => void) | null = null;
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
  fireError() {
    this.onerror?.(new Event('error'));
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

function jsonOk(data: unknown = {}, status = 204): Response {
  return new Response(status === 204 ? null : JSON.stringify(data), { status });
}

describe('useActivePrUpdates', () => {
  it('initial state has hasUpdate=false, headShaChanged=false, commentCountDelta=0', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.headShaChanged).toBe(false);
    expect(result.current.commentCountDelta).toBe(0);
  });

  it('POSTs /api/events/subscriptions { prRef } after handshake', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk()));
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 'sub-1' }));
    await waitFor(() => {
      const subscribeCall = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(subscribeCall).toBeDefined();
    });
    const subscribeCall = fetchMock.mock.calls.find(
      (c: unknown[]) =>
        c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
    );
    expect(JSON.parse((subscribeCall![1] as RequestInit).body as string)).toEqual({
      prRef: refStr,
    });
  });

  it('DELETEs /api/events/subscriptions?prRef=... on unmount', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonOk()));
    globalThis.fetch = fetchMock as typeof fetch;
    const { unmount } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    unmount();
    await waitFor(() => {
      const deleteCall = fetchMock.mock.calls.find(
        (c: unknown[]) => (c[1] as RequestInit)?.method === 'DELETE',
      );
      expect(deleteCall).toBeDefined();
    });
    const deleteCall = fetchMock.mock.calls.find(
      (c: unknown[]) => (c[1] as RequestInit)?.method === 'DELETE',
    );
    expect(deleteCall![0]).toBe(`/api/events/subscriptions?prRef=${encodeURIComponent(refStr)}`);
  });

  it('updates state on pr-updated for matching prRef', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        newHeadSha: 'newsha',
        headShaChanged: true,
        commentCountDelta: 0,
      }),
    );
    expect(result.current.hasUpdate).toBe(true);
    expect(result.current.headShaChanged).toBe(true);
    expect(result.current.commentCountDelta).toBe(0);
  });

  it('ignores pr-updated for non-matching prRef', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: 'someone/else/99',
        headShaChanged: true,
        commentCountDelta: 5,
      }),
    );
    expect(result.current.hasUpdate).toBe(false);
  });

  it('aggregates head + comments across multiple events', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: true,
        commentCountDelta: 2,
      }),
    );
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: false,
        commentCountDelta: 3,
      }),
    );
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: true,
        commentCountDelta: 0,
      }),
    );
    expect(result.current.headShaChanged).toBe(true);
    expect(result.current.commentCountDelta).toBe(5);
  });

  it('re-subscribes (new POST) after the SSE stream reconnects', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/events/ping') {
        return Promise.resolve(new Response('', { status: 503 }));
      }
      return Promise.resolve(jsonOk());
    });
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      FakeEventSource.instances[0].dispatch('subscriber-assigned', { subscriberId: 'sub-1' }),
    );
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(posts).toHaveLength(1);
    });

    act(() => FakeEventSource.instances[0].fireError());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    act(() =>
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 'sub-2' }),
    );
    await waitFor(() => {
      const posts = fetchMock.mock.calls.filter(
        (c: unknown[]) =>
          c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(posts).toHaveLength(2);
    });
  });

  it('resets aggregated state when prRef changes (no banner leak across PRs)', async () => {
    // Regression: useState(initial) only fires on first mount. When
    // PrDetailPage's prRef param changes, the same hook instance was leaving
    // hasUpdate/headShaChanged/commentCountDelta set from the previous PR,
    // showing a stale banner under the new URL until clear() or a new event.
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result, rerender } = renderHook(
      (props: { prRef: PrReference }) => useActivePrUpdates(props.prRef),
      { wrapper, initialProps: { prRef: ref } },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: true,
        commentCountDelta: 4,
      }),
    );
    expect(result.current.hasUpdate).toBe(true);

    rerender({ prRef: { owner: 'foo', repo: 'bar', number: 99 } });
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.headShaChanged).toBe(false);
    expect(result.current.commentCountDelta).toBe(0);
  });

  it('clear() resets aggregated state', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => Promise.resolve(jsonOk())) as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instance.dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: true,
        commentCountDelta: 4,
      }),
    );
    expect(result.current.hasUpdate).toBe(true);
    act(() => result.current.clear());
    expect(result.current.hasUpdate).toBe(false);
    expect(result.current.headShaChanged).toBe(false);
    expect(result.current.commentCountDelta).toBe(0);
  });
});
