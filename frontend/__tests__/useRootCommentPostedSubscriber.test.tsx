import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useRootCommentPostedSubscriber } from '../src/hooks/useRootCommentPostedSubscriber';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import type { PrReference, RootCommentPostedEvent } from '../src/api/types';

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
  vi.restoreAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const otherRef: PrReference = { owner: 'octocat', repo: 'hello', number: 99 };

function dispatch(event: RootCommentPostedEvent) {
  FakeEventSource.instance.dispatch('root-comment-posted', event);
}

describe('useRootCommentPostedSubscriber', () => {
  it('RootCommentPosted_fires_onPosted_for_matching_prRef', async () => {
    const onPosted = vi.fn();
    renderHook(() => useRootCommentPostedSubscriber({ prRef: ref, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => dispatch({ prRef: 'octocat/hello/42', issueCommentId: 987654321 }));

    expect(onPosted).toHaveBeenCalledOnce();
  });

  it('RootCommentPosted_OtherPrRef_Ignored', async () => {
    const onPosted = vi.fn();
    renderHook(() => useRootCommentPostedSubscriber({ prRef: ref, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => dispatch({ prRef: 'octocat/hello/99', issueCommentId: 111 }));

    expect(onPosted).not.toHaveBeenCalled();
  });

  it('does not subscribe when prRef is null', async () => {
    const onPosted = vi.fn();
    renderHook(() => useRootCommentPostedSubscriber({ prRef: null, onPosted }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => dispatch({ prRef: 'octocat/hello/42', issueCommentId: 42 }));

    expect(onPosted).not.toHaveBeenCalled();
  });

  it('PR ref change re-subscribes and ignores old prRef', async () => {
    const onPosted = vi.fn();
    const { rerender } = renderHook(
      ({ prRef }: { prRef: PrReference }) => useRootCommentPostedSubscriber({ prRef, onPosted }),
      { wrapper, initialProps: { prRef: ref } },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    rerender({ prRef: otherRef });

    act(() => dispatch({ prRef: 'octocat/hello/99', issueCommentId: 1 }));
    expect(onPosted).toHaveBeenCalledOnce();

    act(() => dispatch({ prRef: 'octocat/hello/42', issueCommentId: 2 }));
    // Old PR is no longer subscribed — still 1 call.
    expect(onPosted).toHaveBeenCalledOnce();
  });

  it('unmount cleanup unregisters the listener — events after unmount do not call onPosted', async () => {
    const onPosted = vi.fn();
    const { unmount } = renderHook(() => useRootCommentPostedSubscriber({ prRef: ref, onPosted }), {
      wrapper,
    });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // Confirm the listener is active before unmount.
    act(() => dispatch({ prRef: 'octocat/hello/42', issueCommentId: 1 }));
    expect(onPosted).toHaveBeenCalledOnce();

    // Unmount triggers the effect cleanup, which calls the off-fn returned by stream.on().
    unmount();

    // Emit the same event after unmount — onPosted must NOT be called again.
    act(() => dispatch({ prRef: 'octocat/hello/42', issueCommentId: 2 }));
    expect(onPosted).toHaveBeenCalledOnce();
  });
});
