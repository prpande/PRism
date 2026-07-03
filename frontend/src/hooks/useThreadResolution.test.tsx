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

  // 2. After the reloaded isResolved flips to target → pending=false, announce=null,
  //    clearCollapseOverride(threadId) called, and NO second reload after a fast reconcile
  //    (assert reload called exactly once via the SSE path, timer cleared).
  it('releases on a fast reconcile (isResolved flips to target) and does not double-fire the fallback reload', async () => {
    vi.useFakeTimers();
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.pending).toBe(true); // held — the reload hasn't landed yet

    // The SSE-driven reload path (owned by the Task 11 consumer, not this hook) calls reload()
    // once and the resulting refetch flips isResolved to the target. We simulate BOTH halves here:
    // the external reload() call, and the rerender that carries the new isResolved.
    reload();
    rerender({ isResolved: true });

    expect(result.current.pending).toBe(false);
    expect(result.current.announce).toBeNull();
    expect(clearCollapseOverride).toHaveBeenCalledWith('t1');

    // The fallback timer must have been cleared by the reconcile — advancing past FALLBACK_MS
    // must NOT cause the hook to call reload() again.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1); // only our simulated SSE call — not a second, hook-driven one
  });

  // 3. resolveThread rejects/returns {ok:false, code:'token-cannot-write'} → pending=false,
  //    error=token-scope copy, no flip, no clearCollapseOverride.
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.announce).toBeNull();
    expect(result.current.error).toMatch(/Pull requests: Read and write/);
    expect(clearCollapseOverride).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  // 4. {ok:false, code:'subscribe-rejected'} → error='This session lost access to the PR. Reload the page.'
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
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(result.current.error).toBe('This session lost access to the PR. Reload the page.');
  });

  // 5. write ok but isResolved never reaches target; fallback fires at 5000ms → reconcileHint=true
  //    (not silent), pending released.
  it('when the write succeeds but isResolved never reconciles, the 5000ms fallback sets reconcileHint and releases pending', async () => {
    vi.useFakeTimers();
    resolveThread.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    const clearCollapseOverride = vi.fn();
    const { result } = renderHook(() =>
      useThreadResolution({
        prRef,
        threadId: 't1',
        isResolved: false, // stays false — never reconciles to the `true` target
        reload,
        clearCollapseOverride,
      }),
    );

    await act(async () => {
      result.current.invoke();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.pending).toBe(true); // held awaiting reconcile
    expect(result.current.reconcileHint).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(result.current.pending).toBe(false);
    expect(result.current.reconcileHint).toBe(true); // write ok, reload lagging — surfaced, not silent
    expect(reload).toHaveBeenCalledTimes(1); // the fallback's own "one more try"
    expect(clearCollapseOverride).not.toHaveBeenCalled();
  });

  // 6. starting a new invoke() clears a prior error before the request resolves.
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
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toMatch(/Pull requests: Read and write/);

    resolveThread.mockReturnValueOnce(new Promise(() => {})); // second attempt hangs in-flight
    act(() => result.current.invoke());

    expect(result.current.error).toBeNull();
    expect(result.current.pending).toBe(true);
  });

  // prRef: null (pure-render/read-only) — invoke early-returns, no-op.
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

  // Fix 1 (review): a LATE reconcile after the fallback gave up must still complete. The fallback
  // leaves targetRef ARMED, so when the give-up reload finally lands the correct isResolved, the
  // release effect fires — calling clearCollapseOverride AND dropping the now-stale reconcileHint.
  it('completes a late reconcile after the fallback gave up: clears the override and drops the stale hint', async () => {
    vi.useFakeTimers();
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
      await Promise.resolve();
      await Promise.resolve();
    });

    // The reload never lands the target within FALLBACK_MS → give up (hint set, targetRef ARMED).
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.reconcileHint).toBe(true);
    expect(result.current.pending).toBe(false);
    expect(clearCollapseOverride).not.toHaveBeenCalled(); // give-up path did NOT reconcile

    // The give-up reload's refetch finally arrives and flips isResolved to the target.
    rerender({ isResolved: true });

    expect(clearCollapseOverride).toHaveBeenCalledWith('t1'); // late reconcile completed
    expect(result.current.reconcileHint).toBe(false); // stale "couldn't refresh" banner cleared
  });

  // Re-entrancy guard: a second invoke() while the first request is still in flight must NOT fire a
  // second POST (the inFlight ref blocks it — the heart of the "clicked twice" bug).
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

  // A fresh invoke() after a give-up clears reconcileHint synchronously (not only via the effect) —
  // so re-attempting immediately drops the prior "couldn't refresh" banner.
  it('a fresh invoke() after a give-up clears reconcileHint synchronously', async () => {
    vi.useFakeTimers();
    resolveThread.mockResolvedValueOnce({ ok: true });
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
      await Promise.resolve();
      await Promise.resolve();
    });
    act(() => vi.advanceTimersByTime(5000));
    expect(result.current.reconcileHint).toBe(true); // gave up

    resolveThread.mockReturnValueOnce(new Promise(() => {})); // second attempt hangs
    act(() => result.current.invoke());

    expect(result.current.reconcileHint).toBe(false); // reset up-front by the new attempt
  });

  // Fix 2 (review): if an external isResolved flip + the release effect reconcile BEFORE the POST's
  // .then() runs, the fast-path branch must not re-call clearCollapseOverride. Guarded by the
  // `if (targetRef.current === null) return;` check — the effect already handled the reconcile.
  it('does not double-call clearCollapseOverride when the effect reconciles before .then() runs', async () => {
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

    // Now the POST resolves ok and its .then() runs its fast-path branch — it must bail (targetRef
    // is already null), NOT call clearCollapseOverride a second time.
    await act(async () => {
      resolvePost({ ok: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(clearCollapseOverride).toHaveBeenCalledTimes(1); // still exactly once
  });
});
