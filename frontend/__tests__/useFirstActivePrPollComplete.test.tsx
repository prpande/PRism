import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import type { ReactNode } from 'react';
import { useFirstActivePrPollComplete } from '../src/hooks/useFirstActivePrPollComplete';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import { __resetTabIdForTest } from '../src/api/draft';
import type { PrReference } from '../src/api/types';
import type { PrUpdatedEvent } from '../src/api/events';

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
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const otherRef: PrReference = { owner: 'octocat', repo: 'hello', number: 99 };

function dispatchPrUpdated(event: PrUpdatedEvent) {
  FakeEventSource.instance.dispatch('pr-updated', event);
}

describe('useFirstActivePrPollComplete', () => {
  it('BeforeFirstPoll_ReturnsFalse — gate stays closed before any pr-updated event fires', async () => {
    const { result } = renderHook(() => useFirstActivePrPollComplete(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(result.current).toBe(false);
  });

  it('AfterFirstPoll_ReturnsTrue — flips true on the first pr-updated event for the active prRef', async () => {
    const { result } = renderHook(() => useFirstActivePrPollComplete(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );

    expect(result.current).toBe(true);
  });

  it('PrRefChange_ResetsToFalse — switching PRs re-gates until the new PR sees its own pr-updated', async () => {
    const { result, rerender } = renderHook(
      ({ prRef }: { prRef: PrReference }) => useFirstActivePrPollComplete(prRef),
      { wrapper, initialProps: { prRef: ref } },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );
    expect(result.current).toBe(true);

    rerender({ prRef: otherRef });
    expect(result.current).toBe(false);

    // Old prRef's event must not flip the gate for the new prRef.
    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );
    expect(result.current).toBe(false);

    // New prRef's first poll opens the gate.
    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/99',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );
    expect(result.current).toBe(true);
  });

  it('OtherPrRef_Ignored — events for unrelated PRs do not flip the gate', async () => {
    const { result } = renderHook(() => useFirstActivePrPollComplete(ref), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/99',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );
    expect(result.current).toBe(false);
  });

  it('NullPrRef_StaysFalse — does not subscribe when prRef is null', async () => {
    const { result } = renderHook(() => useFirstActivePrPollComplete(null), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );
    expect(result.current).toBe(false);
  });
});
