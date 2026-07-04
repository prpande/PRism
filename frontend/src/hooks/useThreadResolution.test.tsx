// frontend/src/hooks/useThreadResolution.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const resolveThread = vi.fn();
const unresolveThread = vi.fn();
vi.mock('../api/reviewThread', () => ({
  // The arrow wrappers defer the var reference to CALL time, so vi.mock hoisting is fine
  // (mirrors the usePrAction.test.ts mocking pattern for the sibling hook).
  resolveThread: (...a: unknown[]) => resolveThread(...a),
  unresolveThread: (...a: unknown[]) => unresolveThread(...a),
}));

import { useThreadResolution } from './useThreadResolution';

const prRef = { owner: 'o', repo: 'r', number: 1 };

// Drain the POST's .then() chain (mock resolves, then one microtask for the .then body).
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useThreadResolution', () => {
  beforeEach(() => {
    resolveThread.mockReset();
    unresolveThread.mockReset();
    vi.useRealTimers();
  });

  // 1. invoke() on an active thread → pending=true, announce='Resolving…', calls resolveThread.
  it('invoke() on an active (unresolved) thread sets pending + announce and calls resolveThread', async () => {
    resolveThread.mockReturnValueOnce(new Promise(() => {})); // never resolves — inspect the in-flight state
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false,
        reload,
        clearCollapseOverride,
      }),
    );

    act(() => result.current.invoke());

    expect(result.current.pending).toBe(true);
    expect(result.current.announce).toBe('Resolving…');
    expect(resolveThread).toHaveBeenCalledWith(prRef, 't1');
    expect(unresolveThread).not.toHaveBeenCalled();
  });

  // 2. Response-driven reconcile: on {ok:true} the hook RELEASES immediately (no wait on a refetch)
  //    and reloads once. The busy state clears the instant the write returns — it does NOT block on
  //    the isResolved flip. When the flip later lands, clearCollapseOverride fires (fold cleanup).
  it('releases immediately on a successful write, reloads once, and clears the override when the flip lands', async () => {
    resolveThread.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isResolved: boolean }) =>
        useThreadResolution({
          prRef,
          threadId: 't1',
          isResolved: props.isResolved,
          reload,
          clearCollapseOverride,
        }),
      { initialProps: { isResolved: false } },
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });

    // Released on the 200 — no waiting on a refetch, no timer.
    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.announce).toBe('Conversation resolved');
    expect(reload).toHaveBeenCalledTimes(1);
    // Override cleanup waits for the actual flip — not fired yet.
    expect(clearCollapseOverride).not.toHaveBeenCalled();

    // The reload's refetch flips isResolved to the target → override cleanup runs exactly once.
    rerender({ isResolved: true });
    expect(clearCollapseOverride).toHaveBeenCalledTimes(1);
    expect(clearCollapseOverride).toHaveBeenCalledWith('t1');
  });

  // 3. A successful write NEVER surfaces an error banner (the Bug 2 regression: the old
  //    confirm-then-apply flashed a red "couldn't refresh" hint past a 5s fallback even on success).
  it('never sets an error on the success path, even when the isResolved flip never lands', async () => {
    resolveThread.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false, // stays false — the flip never lands
        reload,
        clearCollapseOverride,
      }),
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.error).toBeNull(); // no red banner on a successful write
    expect(reload).toHaveBeenCalledTimes(1); // the one reload; there is no fallback second try
    expect(clearCollapseOverride).not.toHaveBeenCalled();
  });

  // 4. resolveThread returns {ok:false, code:'token-cannot-write'} → pending=false, token-scope
  //    error copy, no flip, no reload, no clearCollapseOverride.
  it('on {ok:false, code:"token-cannot-write"} releases pending with the token-scope error copy', async () => {
    resolveThread.mockResolvedValueOnce({ ok: false, code: 'token-cannot-write' });
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false,
        reload,
        clearCollapseOverride,
      }),
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.announce).toBeNull();
    expect(result.current.error).toMatch(/Pull requests: Read and write/);
    expect(clearCollapseOverride).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // 5. {ok:false, code:'subscribe-rejected'} → session-lost-access copy.
  it('on {ok:false, code:"subscribe-rejected"} sets the session-lost-access error copy', async () => {
    resolveThread.mockResolvedValueOnce({ ok: false, code: 'subscribe-rejected' });
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false,
        reload: vi.fn(),
        clearCollapseOverride: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });

    expect(result.current.error).toBe('This session lost access to the PR. Reload the page.');
  });

  // 6. Unresolve path: on a resolved thread invoke() calls unresolveThread, announces
  //    'Unresolving…' → 'Conversation unresolved', reloads, and the effect clears on the flip.
  it('invoke() on a resolved thread calls unresolveThread and reconciles the reopen', async () => {
    unresolveThread.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isResolved: boolean }) =>
        useThreadResolution({
          prRef,
          threadId: 't1',
          isResolved: props.isResolved,
          reload,
          clearCollapseOverride,
        }),
      { initialProps: { isResolved: true } },
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });

    expect(unresolveThread).toHaveBeenCalledWith(prRef, 't1');
    expect(resolveThread).not.toHaveBeenCalled();
    expect(result.current.announce).toBe('Conversation unresolved');
    expect(reload).toHaveBeenCalledTimes(1);

    rerender({ isResolved: false });
    expect(clearCollapseOverride).toHaveBeenCalledWith('t1');
  });

  // 7. starting a new invoke() clears a prior error before the request resolves.
  it('a new invoke() clears a prior error immediately, before the new request resolves', async () => {
    resolveThread.mockResolvedValueOnce({ ok: false, code: 'token-cannot-write' });
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false,
        reload: vi.fn(),
        clearCollapseOverride: vi.fn(),
      }),
    );

    await act(async () => {
      result.current.invoke();
      await settle();
    });
    expect(result.current.error).toMatch(/Pull requests: Read and write/);

    resolveThread.mockReturnValueOnce(new Promise(() => {})); // second attempt hangs in-flight
    act(() => result.current.invoke());

    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(true);
  });

  // 8. prRef: null (pure-render/read-only) — invoke early-returns, no-op.
  it('is a no-op when prRef is null (pure-render/read-only mode)', () => {
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef: null,
        threadId: 't1',
        isResolved: false,
        reload,
        clearCollapseOverride,
      }),
    );

    act(() => result.current.invoke());

    expect(result.current.pending).toBe(false);
    expect(resolveThread).not.toHaveBeenCalled();
    expect(unresolveThread).not.toHaveBeenCalled();
  });

  // 9. Re-entrancy guard: a second invoke() while the first request is still in flight must NOT fire
  //    a second POST (the inFlight ref blocks it — the heart of the "clicked twice" bug).
  it('ignores a second invoke() while the first request is still in flight', () => {
    resolveThread.mockReturnValue(new Promise(() => {})); // never resolves — stays in flight
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false,
        reload: vi.fn(),
        clearCollapseOverride: vi.fn(),
      }),
    );

    act(() => result.current.invoke());
    act(() => result.current.invoke());

    expect(resolveThread).toHaveBeenCalledTimes(1); // second invoke short-circuited by inFlight
  });

  // 10. A fast external flip that lands BEFORE the POST's .then() runs must still reconcile exactly
  //     once (the effect owns clearCollapseOverride; the success .then() never calls it directly).
  it('clears the override exactly once when the flip lands before .then() runs', async () => {
    let resolvePost!: (v: { ok: true }) => void;
    resolveThread.mockReturnValueOnce(
      new Promise((r) => {
        resolvePost = r;
      }),
    );
    const clearCollapseOverride = vi.fn();
    const { result, rerender } = renderHook(
      (props: { isResolved: boolean }) =>
        useThreadResolution({
          prRef,
          threadId: 't1',
          isResolved: props.isResolved,
          reload: vi.fn(),
          clearCollapseOverride,
        }),
      { initialProps: { isResolved: false } },
    );

    act(() => result.current.invoke());

    // A fast SSE flip lands BEFORE the POST resolves → the release effect reconciles first.
    rerender({ isResolved: true });
    expect(clearCollapseOverride).toHaveBeenCalledTimes(1);

    // The POST then resolves ok; its success branch must NOT call clearCollapseOverride again.
    await act(async () => {
      resolvePost({ ok: true });
      await settle();
    });

    expect(clearCollapseOverride).toHaveBeenCalledTimes(1); // still exactly once
  });
});
