import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ReactNode } from 'react';
import { EventStreamProvider, useEventSource } from '../src/hooks/useEventSource';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

beforeEach(() => {
  installFakeEventSource();
  vi.restoreAllMocks();
});

describe('useEventSource / EventStreamProvider', () => {
  it('provides a non-null handle to children inside Provider', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    const { result } = renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(result.current).not.toBeNull());
    expect(typeof result.current?.subscriberId).toBe('function');
  });

  it('returns null when used outside Provider', () => {
    const { result } = renderHook(() => useEventSource());
    expect(result.current).toBeNull();
  });

  it('closes the EventSource when Provider unmounts', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    const { unmount } = renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    unmount();
    expect(FakeEventSource.instances[0].closed).toBe(true);
  });

  it('only opens one EventSource regardless of how many consumers read context', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(
      () => {
        useEventSource();
        useEventSource();
        useEventSource();
        return null;
      },
      { wrapper },
    );
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('dispatches prism-identity-changed on a well-formed identity-changed SSE frame', async () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const spy = vi.fn();
    window.addEventListener('prism-identity-changed', spy);
    try {
      FakeEventSource.instance.dispatch('identity-changed', { type: 'identity-change' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('prism-identity-changed', spy);
    }
  });

  it('dispatches the bridge window event even when an in-tree listener throws', async () => {
    // Regression for code-review #2: original order was listeners.forEach → set
    // parsed=true → dispatch bridge. A throwing listener aborted the try block
    // and silently suppressed the bridge — useAuth + useSubmitInFlight would
    // miss the signal even though JSON.parse succeeded. Fixed by dispatching
    // the bridge BEFORE invoking listeners, and per-subscriber catch on each
    // listener callback.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    const { result } = renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // Register a throwing in-tree listener.
    const offThrowing = result.current!.on('identity-changed', () => {
      throw new Error('downstream consumer bug');
    });
    const spy = vi.fn();
    window.addEventListener('prism-identity-changed', spy);
    try {
      FakeEventSource.instance.dispatch('identity-changed', { type: 'identity-change' });
      // The bridge MUST have fired despite the throwing listener.
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      offThrowing();
      window.removeEventListener('prism-identity-changed', spy);
    }
  });

  it('does NOT dispatch the bridge window event when the payload is malformed JSON', async () => {
    // Regression: pre-fix, the bridge dispatch ran AFTER the try/catch and fired
    // even when JSON.parse failed — a garbled identity-changed frame would
    // trigger an unwanted useAuth refetch. The fix gates the dispatch on a
    // `parsed` flag inside the try block.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const spy = vi.fn();
    window.addEventListener('prism-identity-changed', spy);
    try {
      FakeEventSource.instance.dispatchRaw('identity-changed', '{not valid json');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('prism-identity-changed', spy);
    }
  });

  it('does NOT dispatch prism-events-reconnected on the initial subscriber-assigned', async () => {
    // Regression for Copilot iter-4 finding C10: the dispatch must NOT fire on
    // the first subscriber-assigned (initial connect) — only on subsequent ones
    // (post-reconnect). Pre-fix, reconnect() dispatched unconditionally and could
    // even fire while the new EventSource was still mid-handshake.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const spy = vi.fn();
    window.addEventListener('prism-events-reconnected', spy);
    try {
      FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 's1' });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('prism-events-reconnected', spy);
    }
  });

  it('dispatches prism-events-reconnected on a subsequent subscriber-assigned (reconnect path)', async () => {
    // Companion to the test above: AFTER the first subscriber-assigned flips
    // the hasEverConnected flag, the next subscriber-assigned on the same
    // openEventStream() invocation IS treated as a reconnect signal and fires
    // the bridge. In production this second handshake happens when reconnect()
    // closes the old EventSource and opens a new one; in this jsdom harness we
    // simulate it by dispatching subscriber-assigned twice on the same fake.
    const wrapper = ({ children }: { children: ReactNode }) => (
      <EventStreamProvider>{children}</EventStreamProvider>
    );
    renderHook(() => useEventSource(), { wrapper });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    // First subscriber-assigned: flips the flag, no dispatch.
    FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 's1' });

    const spy = vi.fn();
    window.addEventListener('prism-events-reconnected', spy);
    try {
      // Second subscriber-assigned: reconnect path.
      FakeEventSource.instance.dispatch('subscriber-assigned', { subscriberId: 's2' });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('prism-events-reconnected', spy);
    }
  });
});
