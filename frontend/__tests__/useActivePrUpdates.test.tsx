import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { useActivePrUpdates } from '../src/hooks/useActivePrUpdates';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import type { PrReference } from '../src/api/types';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const refStr = 'octocat/hello/42';

beforeEach(() => {
  installFakeEventSource();
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
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3000 });

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

  // #142 Bug 1 — regression guard, not a fixed bug. The live-fanout SSE design
  // (SseChannel writes events only to currently-connected subscribers, emits no
  // `id:` line, and reads no Last-Event-ID) never replays buffered events on
  // reconnect, and ActivePrPoller tracks LastCommentCount server-side so each
  // delta it sends is a genuine new change. So the "delta double-counts on
  // reconnect" premise of the original deferral cannot occur. This test locks
  // that in: a reconnect alone must not inflate the accumulated count, and a
  // genuinely new post-reconnect event must still accumulate correctly.
  it('does not double-count commentCountDelta across an SSE reconnect', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // 503 (not 401) routes onerror through the reconnect path, not reload.
      if (url === '/api/events/ping') return Promise.resolve(new Response('', { status: 503 }));
      return Promise.resolve(jsonOk());
    });
    globalThis.fetch = fetchMock as typeof fetch;
    const { result } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() =>
      FakeEventSource.instances[0].dispatch('subscriber-assigned', { subscriberId: 'sub-1' }),
    );

    // Server delivers +3 comments once.
    act(() =>
      FakeEventSource.instances[0].dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: false,
        commentCountDelta: 3,
      }),
    );
    expect(result.current.commentCountDelta).toBe(3);

    // SSE drops and reconnects (a fresh EventSource). No replay → no resent +3.
    act(() => FakeEventSource.instances[0].fireError());
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3000 });
    act(() =>
      FakeEventSource.instances[1].dispatch('subscriber-assigned', { subscriberId: 'sub-2' }),
    );

    // The reconnect alone must not inflate the count.
    expect(result.current.commentCountDelta).toBe(3);

    // A genuinely new event after reconnect still accumulates correctly.
    act(() =>
      FakeEventSource.instances[1].dispatch('pr-updated', {
        prRef: refStr,
        headShaChanged: false,
        commentCountDelta: 1,
      }),
    );
    expect(result.current.commentCountDelta).toBe(4);
  });

  // #142 Bug 2 — DELETE-before-POST ordering race. On unmount during an in-flight
  // subscribe POST, the cleanup DELETE must be chained AFTER the POST settles so
  // the server always sees POST→DELETE. Otherwise a DELETE that reaches the server
  // first is a no-op and the later POST lands a dangling subscription.
  it('delays the unsubscribe DELETE until the in-flight subscribe POST resolves', async () => {
    let resolvePost!: (r: Response) => void;
    const postGate = new Promise<Response>((res) => {
      resolvePost = res;
    });
    const order: string[] = [];
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/events/subscriptions' && init?.method === 'POST') {
        return postGate.then((r) => {
          order.push('post-resolved');
          return r;
        });
      }
      if ((init as RequestInit)?.method === 'DELETE') {
        order.push('delete-called');
        return Promise.resolve(jsonOk());
      }
      return Promise.resolve(jsonOk());
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { unmount } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 'sub-1' }));

    // Wait until the POST has been issued (now pending on postGate).
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(post).toBeDefined();
    });

    // Unmount while the POST is still in flight.
    unmount();

    // Ordering guard: DELETE must NOT have fired while the POST is unresolved.
    expect(order).not.toContain('delete-called');

    // Resolve the POST; only now may the DELETE fire.
    await act(async () => {
      resolvePost(jsonOk());
    });
    await waitFor(() => expect(order).toContain('delete-called'));

    // The POST resolved strictly before the DELETE was issued.
    expect(order).toEqual(['post-resolved', 'delete-called']);
  });

  // #142 — the cleanup chains the DELETE off `lastSubscribePost.catch(...)`, so a
  // failed subscribe POST must NOT swallow the unsubscribe. Without the `.catch()`
  // before `.then(delete)`, a rejected POST would short-circuit the chain and the
  // server would keep the (never-confirmed) subscription. (claude[bot] coverage gap.)
  it('still issues the unsubscribe DELETE when the subscribe POST fails', async () => {
    let deleteCalled = false;
    const fetchMock = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/events/subscriptions' && init?.method === 'POST') {
        // Non-2xx → apiClient.post rejects with ApiError.
        return Promise.resolve(new Response('{"detail":"boom"}', { status: 500 }));
      }
      if ((init as RequestInit)?.method === 'DELETE') {
        deleteCalled = true;
        return Promise.resolve(jsonOk());
      }
      return Promise.resolve(jsonOk());
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { unmount } = renderHook(() => useActivePrUpdates(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 'sub-1' }));

    // Wait until the (failing) POST has been attempted.
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          c[0] === '/api/events/subscriptions' && (c[1] as RequestInit)?.method === 'POST',
      );
      expect(post).toBeDefined();
    });

    unmount();

    // DELETE fires despite the POST rejection.
    await waitFor(() => expect(deleteCalled).toBe(true));
  });
});
