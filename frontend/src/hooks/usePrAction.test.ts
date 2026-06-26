// frontend/src/hooks/usePrAction.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const closePr = vi.fn();
const reopenPr = vi.fn();
const markReady = vi.fn();
vi.mock('../api/prLifecycle', () => ({
  // The arrow wrappers defer the var reference to CALL time, so vi.mock hoisting is fine.
  closePr: (...a: unknown[]) => closePr(...a),
  reopenPr: (...a: unknown[]) => reopenPr(...a),
  markReady: (...a: unknown[]) => markReady(...a),
  convertToDraft: vi.fn(),
}));
const show = vi.fn();
vi.mock('../components/Toast/useToast', () => ({
  useToast: () => ({ show, dismiss: vi.fn(), toasts: [] }),
}));

import { usePrAction } from './usePrAction';

const prRef = { owner: 'o', repo: 'r', number: 1 };
const OPEN = { isClosed: false, isDraft: false }; // close target NOT yet reached
const CLOSED = { isClosed: true, isDraft: false }; // close target reached

describe('usePrAction', () => {
  beforeEach(() => {
    closePr.mockReset();
    reopenPr.mockReset();
    markReady.mockReset();
    show.mockReset();
    vi.useRealTimers();
  });

  it('sets pending then clears it on POST 200', async () => {
    let resolve!: (v: { ok: true }) => void;
    closePr.mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const reload = vi.fn();
    const { result } = renderHook(() => usePrAction({ prRef, reload, prState: OPEN }));

    act(() => result.current.invoke('close'));
    expect(result.current.pending).toBe('close');

    await act(async () => {
      resolve({ ok: true });
    });
    await waitFor(() => expect(result.current.pending).toBeNull());
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
    prState = { isClosed: false, isDraft: false };
    rerender();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(reload).toHaveBeenCalledTimes(1); // unrelated reload did NOT disarm it (round-2 finding A1)
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
});
