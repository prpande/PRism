import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { MarkAllReadButton } from '../src/components/PrDetail/OverviewTab/MarkAllReadButton';
import { EventStreamProvider } from '../src/hooks/useEventSource';
import * as draftApi from '../src/api/draft';
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

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = FakeEventSource;
  __resetTabIdForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <EventStreamProvider>{children}</EventStreamProvider>
);

function dispatchPrUpdated(event: PrUpdatedEvent) {
  FakeEventSource.instance.dispatch('pr-updated', event);
}

describe('MarkAllReadButton', () => {
  it('MarkAllReadButton_DisabledBeforeFirstPoll — disabled until first pr-updated event arrives', async () => {
    render(<MarkAllReadButton prRef={ref} />, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const btn = screen.getByRole('button', { name: /mark all read/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('aria-disabled', 'true');
  });

  it('MarkAllReadButton_FiresMarkAllReadPatch_AfterPoll — clicks fire the markAllRead patch once gated open', async () => {
    const spy = vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: null });
    render(<MarkAllReadButton prRef={ref} />, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );

    const btn = screen.getByRole('button', { name: /mark all read/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(spy).toHaveBeenCalledWith(ref, { kind: 'markAllRead' });
  });

  it('DoubleClick_FiresOnlyOnePatch — in-flight guard prevents concurrent dispatches', async () => {
    let resolveSend: (v: { ok: true; assignedId: null }) => void = () => undefined;
    const pending = new Promise<{ ok: true; assignedId: null }>((r) => {
      resolveSend = r;
    });
    const spy = vi.spyOn(draftApi, 'sendPatch').mockImplementation(() => pending);
    render(<MarkAllReadButton prRef={ref} />, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );

    const btn = screen.getByRole('button', { name: /mark all read/i });
    fireEvent.click(btn);
    fireEvent.click(btn);

    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledTimes(1);

    // Resolve the pending request so React state can settle without leaking.
    await act(async () => {
      resolveSend({ ok: true, assignedId: null });
      await Promise.resolve();
      await Promise.resolve();
    });
  });

  it('LogsAndStaysEnabled_OnNetworkFailure — non-ok result is logged and the button stays clickable', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const spy = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: false, status: 0, kind: 'network', body: 'fetch failed' });
    render(<MarkAllReadButton prRef={ref} />, { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() =>
      dispatchPrUpdated({
        prRef: 'octocat/hello/42',
        headShaChanged: false,
        commentCountDelta: 0,
      }),
    );

    const btn = screen.getByRole('button', { name: /mark all read/i });
    fireEvent.click(btn);
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(btn).not.toBeDisabled();
    expect(warnSpy).toHaveBeenCalled();
  });
});
