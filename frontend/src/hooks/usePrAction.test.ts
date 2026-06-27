// frontend/src/hooks/usePrAction.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const closePr = vi.fn();
const reopenPr = vi.fn();
const markReady = vi.fn();
const mergePrMock = vi.fn();
vi.mock('../api/prLifecycle', () => ({
  // The arrow wrappers defer the var reference to CALL time, so vi.mock hoisting is fine.
  closePr: (...a: unknown[]) => closePr(...a),
  reopenPr: (...a: unknown[]) => reopenPr(...a),
  markReady: (...a: unknown[]) => markReady(...a),
  convertToDraft: vi.fn(),
  mergePr: (...a: unknown[]) => mergePrMock(...a),
}));
const show = vi.fn();
const toastShow = show; // alias used by the merge tests below
vi.mock('../components/Toast/useToast', () => ({
  useToast: () => ({ show, dismiss: vi.fn(), toasts: [] }),
}));

import { usePrAction } from './usePrAction';

const prRef = { owner: 'o', repo: 'r', number: 1 };
const OPEN = { isClosed: false, isDraft: false, isMerged: false }; // close target NOT yet reached
const CLOSED = { isClosed: true, isDraft: false, isMerged: false }; // close target reached

describe('usePrAction', () => {
  beforeEach(() => {
    closePr.mockReset();
    reopenPr.mockReset();
    markReady.mockReset();
    mergePrMock.mockReset();
    show.mockReset();
    vi.useRealTimers();
  });

  it('clears pending on POST 200 when the target state is already observed', async () => {
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const reload = vi.fn();
    // prState=CLOSED → reachedTarget('close') is already true, so the .then releases at once.
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: CLOSED }));

    act(() => result.current.invoke('close'));
    expect(result.current.pending).toBe('close');

    await act(async () => {
      resolve({ ok: true });
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
  });

  it('HOLDS pending through the reconcile window, then clears it when the target is observed', async () => {
    // The double-click guard (#566): after a 200, the PR isn't reconciled yet (still OPEN), so
    // `pending` must STAY set — the button stays disabled — until the observed state reaches the
    // target. Releasing on the bare 200 would briefly re-enable the (stale) action for re-click.
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));

    await act(async () => {
      result.current.invoke('close');
    });
    // 200 resolved but the UI hasn't reconciled (prState still OPEN) → still busy.
    expect(result.current.pending).toBe('close');

    // The reconcile reload flips the PR to closed → pending releases.
    prState = CLOSED;
    rerender();
    await waitFor(() => expect(result.current.pending).toBeNull());
  });

  it('a second invoke is ignored while pending is held through the reconcile window', async () => {
    // Even though the 200 has resolved, inFlight stays held until reconcile — so a re-click does
    // NOT fire a second POST (the heart of the "clicked twice, thought it didn't work" bug).
    closePr.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => {
      result.current.invoke('close');
    });
    expect(result.current.pending).toBe('close'); // held (OPEN not reconciled to CLOSED yet)
    act(() => result.current.invoke('close')); // re-click during the reconcile window
    expect(closePr).toHaveBeenCalledTimes(1); // blocked — no second POST
  });

  it('releases pending when the SSE-drop fallback fires', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    // prState stays OPEN — the target is never observed, so the fallback bounds the held state.
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: OPEN }));
    await act(async () => {
      result.current.invoke('close');
    });
    expect(result.current.pending).toBe('close'); // held while awaiting reconcile
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(result.current.pending).toBeNull(); // released at the fallback boundary
  });

  it('re-entrancy guard ignores a second invoke while one is in flight (same kind)', async () => {
    closePr.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    act(() => result.current.invoke('close'));
    act(() => result.current.invoke('close'));
    expect(closePr).toHaveBeenCalledTimes(1);
  });

  it('re-entrancy guard blocks a DIFFERENT kind while one is in flight (adversarial: single inFlight ref)', async () => {
    closePr.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    act(() => result.current.invoke('close'));
    act(() => result.current.invoke('reopen'));
    expect(closePr).toHaveBeenCalledTimes(1);
    expect(reopenPr).not.toHaveBeenCalled(); // the single inFlight ref blocks a different kind too
  });

  it('on failure clears pending and shows an error toast with mapped copy', async () => {
    closePr.mockResolvedValueOnce({ ok: false, code: 'token-cannot-write' });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => {
      result.current.invoke('close');
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(show.mock.calls[0][0].message).toMatch(/Pull requests: Read and write/);
  });

  // Plan ce-doc-review round 2 (scope): the spec lists ALL SIX codes as required copy mappings.
  it.each([
    ['repo-rule-blocked', /repository rule/i],
    ['reopen-not-possible', /source branch was deleted/i],
    ['plan-unsupported-drafts', /draft pull requests/i],
    ['subscribe-rejected', /lost access/i],
    ['rate-limited', /rate-limiting|try again shortly/i],
    ['something-unknown', /could not be completed/i], // generic fallthrough
  ])('maps the %s error code to its copy', async (code, re) => {
    closePr.mockResolvedValueOnce({ ok: false, code });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => {
      result.current.invoke('close');
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show.mock.calls[0][0].message).toMatch(re);
  });

  it('does NOT show an error toast on a benign success', async () => {
    markReady.mockResolvedValueOnce({ ok: true });
    const { result } = renderHook(() => usePrAction({ prRef, reload: vi.fn(), prState: OPEN }));
    await act(async () => {
      result.current.invoke('ready');
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(show).not.toHaveBeenCalled();
  });

  it('fires the fallback reload if the target state is NOT observed within the timeout', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    // prState stays OPEN — the close target (isClosed) is never observed.
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: OPEN }));
    await act(async () => {
      result.current.invoke('close');
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire the fallback when an unrelated reload changes prState but NOT to the target', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    await act(async () => {
      result.current.invoke('close');
    });
    // A comment-post reload swaps prState to a NEW open object (still not closed): fallback must STAY armed.
    prState = { isClosed: false, isDraft: false, isMerged: false };
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1); // unrelated reload did NOT disarm it (round-2 finding A1)
  });

  it('keeps the fallback armed when an effect-triggering reload still does not reach the target', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    await act(async () => {
      result.current.invoke('close');
    });
    // A draft-status reload changes isDraft (so the effect fires), but isClosed is still false —
    // reachedTarget('close', {isClosed:false,isDraft:true}) is false → timer stays armed.
    prState = { isClosed: false, isDraft: true, isMerged: false };
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1); // fallback fired because target was not reached
  });

  it('cancels the fallback when the target state is observed after the timer armed', async () => {
    vi.useFakeTimers();
    closePr.mockResolvedValueOnce({ ok: true });
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    await act(async () => {
      result.current.invoke('close');
    });
    // The action's own reconcile reload flips the PR to closed:
    prState = CLOSED;
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('does NOT arm the fallback when the target state is reached BEFORE the POST resolves (arm-after-reload race)', async () => {
    vi.useFakeTimers();
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const reload = vi.fn();
    let prState = OPEN;
    const { result, rerender } = renderHook(() => usePrAction({ prRef, reload, prState }));
    act(() => result.current.invoke('close'));
    // Fast SSE reload flips to closed BEFORE the POST 200 resolves:
    prState = CLOSED;
    rerender();
    await act(async () => {
      resolve({ ok: true });
    }); // .then sees target already reached — must NOT arm
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).not.toHaveBeenCalled();
  });

  it('merge: holds pending through reconcile, releases when isMerged flips', async () => {
    vi.useFakeTimers();
    mergePrMock.mockResolvedValue({ ok: true });
    let state = { isClosed: false, isDraft: false, isMerged: false };
    const reload = vi.fn();
    const { result, rerender } = renderHook(
      (s) => usePrAction({ prRef, reload, prState: s }),
      { initialProps: state },
    );

    act(() => result.current.invoke('merge', { method: 'squash', headSha: 'abc' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pending).toBe('merge'); // held through reconcile

    state = { ...state, isMerged: true };
    rerender(state); // SSE reload observed isMerged
    expect(result.current.pending).toBeNull(); // released on target
  });

  it('merge-head-changed: reloads, releases, and blocks re-merge on the same headSha', async () => {
    mergePrMock.mockResolvedValue({ ok: false, code: 'merge-head-changed' });
    const reload = vi.fn();
    const { result } = renderHook(() =>
      usePrAction({ prRef, reload, prState: { isClosed: false, isDraft: false, isMerged: false } }),
    );
    await act(async () => {
      result.current.invoke('merge', { method: 'merge', headSha: 'old' });
      await Promise.resolve();
    });
    expect(reload).toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    // re-merge with the SAME headSha is blocked (stale-sha gate)
    await act(async () => {
      result.current.invoke('merge', { method: 'merge', headSha: 'old' });
      await Promise.resolve();
    });
    expect(mergePrMock).toHaveBeenCalledTimes(1); // second invoke short-circuited
  });

  it('merge-not-mergeable: reconciles to success when isMerged flips during checking', async () => {
    vi.useFakeTimers();
    mergePrMock.mockResolvedValue({ ok: false, code: 'merge-not-mergeable' });
    let state = { isClosed: false, isDraft: false, isMerged: false };
    const { result, rerender } = renderHook(
      (s) => usePrAction({ prRef, reload: vi.fn(), prState: s }),
      { initialProps: state },
    );
    await act(async () => {
      result.current.invoke('merge', { method: 'merge', headSha: 'abc' });
      await Promise.resolve();
    });
    expect(result.current.mergePhase).toBe('checking');
    state = { ...state, isMerged: true };
    rerender(state); // reload observed the merge actually landed
    expect(result.current.pending).toBeNull(); // reconciled to success, no error toast
    expect(toastShow).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
  });

  it('merge: reload-silent fallback fires info snackbar after 10s when isMerged never arrives', async () => {
    vi.useFakeTimers();
    mergePrMock.mockResolvedValue({ ok: true });
    const reload = vi.fn();
    const prState = { isClosed: false, isDraft: false, isMerged: false };
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState }));

    act(() => result.current.invoke('merge', { method: 'merge', headSha: 'abc' }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.pending).toBe('merge'); // held through reconcile (isMerged never observed)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'info' }));
    expect(result.current.pending).toBeNull();
    expect(result.current.mergePhase).toBe('idle');
  });

  it('merge: not-mergeable timeout fires error toast after 10s when the reconcile never lands', async () => {
    vi.useFakeTimers();
    mergePrMock.mockResolvedValue({ ok: false, code: 'merge-not-mergeable' });
    const reload = vi.fn();
    const prState = { isClosed: false, isDraft: false, isMerged: false };
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState }));

    await act(async () => {
      result.current.invoke('merge', { method: 'merge', headSha: 'abc' });
      await Promise.resolve();
    });
    expect(result.current.mergePhase).toBe('checking'); // merge-not-mergeable sets checking phase

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(show).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error' }));
    expect(result.current.pending).toBeNull();
    expect(result.current.mergePhase).toBe('idle');
  });
});
