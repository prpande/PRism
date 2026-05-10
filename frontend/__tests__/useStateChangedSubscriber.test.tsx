import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useStateChangedSubscriber } from '../src/hooks/useStateChangedSubscriber';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { __resetTabIdForTest, getTabId } from '../src/api/draft';
import type { PrReference, StateChangedEvent } from '../src/api/types';

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
  __resetTabIdForTest();
  vi.restoreAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const otherRef: PrReference = { owner: 'octocat', repo: 'hello', number: 99 };

function dispatch(event: StateChangedEvent) {
  FakeEventSource.instance.dispatch('state-changed', event);
}

describe('useStateChangedSubscriber', () => {
  it('StateChanged_DraftComments_InvalidatesDraftSession — fires onSessionChange', async () => {
    const onSessionChange = vi.fn();
    renderHook(() => useStateChangedSubscriber({ prRef: ref, onSessionChange }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['draft-comments'],
        sourceTabId: 'other-tab',
      }),
    );

    expect(onSessionChange).toHaveBeenCalledOnce();
  });

  it('StateChanged_OwnTab_DoesNotRefetch — own-tab events are filtered', async () => {
    const onSessionChange = vi.fn();
    renderHook(() => useStateChangedSubscriber({ prRef: ref, onSessionChange }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['draft-comments'],
        sourceTabId: getTabId(),
      }),
    );

    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('StateChanged_OtherPrRef_Ignored', async () => {
    const onSessionChange = vi.fn();
    renderHook(() => useStateChangedSubscriber({ prRef: ref, onSessionChange }), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatch({
        prRef: 'octocat/hello/99',
        fieldsTouched: ['draft-comments'],
        sourceTabId: 'other-tab',
      }),
    );

    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('StateChanged_LastSeenCommentId_InvalidatesInboxBadge — addendum A7', async () => {
    const onSessionChange = vi.fn();
    const onInboxBadgeInvalidation = vi.fn();
    renderHook(
      () =>
        useStateChangedSubscriber({
          prRef: ref,
          onSessionChange,
          onInboxBadgeInvalidation,
        }),
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['last-seen-comment-id'],
        sourceTabId: 'other-tab',
      }),
    );

    expect(onSessionChange).toHaveBeenCalledOnce();
    expect(onInboxBadgeInvalidation).toHaveBeenCalledOnce();
  });

  it('LastSeenCommentId among other fields still invalidates the badge', async () => {
    const onSessionChange = vi.fn();
    const onInboxBadgeInvalidation = vi.fn();
    renderHook(
      () =>
        useStateChangedSubscriber({
          prRef: ref,
          onSessionChange,
          onInboxBadgeInvalidation,
        }),
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['draft-comments', 'last-seen-comment-id'],
        sourceTabId: 'other-tab',
      }),
    );

    expect(onInboxBadgeInvalidation).toHaveBeenCalledOnce();
  });

  it('does not subscribe when prRef is null', async () => {
    const onSessionChange = vi.fn();
    renderHook(
      () =>
        useStateChangedSubscriber({
          prRef: null,
          onSessionChange,
        }),
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    // The stream exists but our subscriber never registered. Dispatch
    // anyway and confirm callback wasn't called.
    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['draft-comments'],
        sourceTabId: 'other-tab',
      }),
    );
    expect(onSessionChange).not.toHaveBeenCalled();
  });

  it('PR ref change re-subscribes', async () => {
    const onSessionChange = vi.fn();
    const { rerender } = renderHook(
      ({ prRef }: { prRef: PrReference }) =>
        useStateChangedSubscriber({ prRef, onSessionChange }),
      { wrapper, initialProps: { prRef: ref } },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    rerender({ prRef: otherRef });

    act(() =>
      dispatch({
        prRef: 'octocat/hello/99',
        fieldsTouched: ['draft-comments'],
        sourceTabId: 'other-tab',
      }),
    );
    expect(onSessionChange).toHaveBeenCalledOnce();

    act(() =>
      dispatch({
        prRef: 'octocat/hello/42',
        fieldsTouched: ['draft-comments'],
        sourceTabId: 'other-tab',
      }),
    );
    // First PR is no longer subscribed → still 1 call.
    expect(onSessionChange).toHaveBeenCalledOnce();
  });
});
