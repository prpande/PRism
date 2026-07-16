// frontend/src/hooks/useCheckRuns.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCheckRuns } from './useCheckRuns';
import * as api from '../api/checks';
import { ApiError } from '../api/client';
import type { CheckRun, ChecksResponse } from '../api/types';

const PR = { owner: 'o', repo: 'r', number: 1 };
const SHA = 'abc';

function resp(over: Partial<ChecksResponse> = {}): ChecksResponse {
  return { checks: [], headSha: SHA, degraded: 'none', ...over };
}

// Shared CheckRun factory — defaults to a terminal green check; override per test.
const mkCheck = (over: Partial<CheckRun> = {}): CheckRun => ({
  name: 'build',
  status: 'completed',
  conclusion: 'success',
  source: 'check-run',
  startedAt: null,
  completedAt: null,
  detailsUrl: null,
  summary: null,
  appName: null,
  body: null,
  checkRunId: null,
  ...over,
});

describe('useCheckRuns', () => {
  beforeEach(() => {
    // shouldAdvanceTime: true lets waitFor's internal setTimeout drain. The sinon fake clock
    // still governs Date.now(), and advanceTimersByTimeAsync advances BOTH the timers AND
    // Date.now() — so the hook's LATE_REGISTRATION_MS window expires correctly in the
    // "re-polls empty then stops" test. Don't switch to a real-clock Date.now() mock.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is idle and does NOT fetch while inactive', () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp());
    const { result } = renderHook(() => useCheckRuns(PR, SHA, false));
    expect(result.current.status).toBe('idle');
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches on first activation and reports a non-empty list as ok', async () => {
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(
      resp({
        checks: [mkCheck()],
      }),
    );
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.checks).toHaveLength(1);
  });

  it('definitive-empty reports empty immediately', async () => {
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [] }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('empty'));
  });

  it('keeps polling while a check is non-terminal, stops once all terminal', async () => {
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(
        resp({
          checks: [mkCheck({ status: 'in-progress', conclusion: null })],
        }),
      )
      .mockResolvedValue(
        resp({
          checks: [mkCheck()],
        }),
      );
    renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    // now all terminal → no further fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('stops the loop and reports error on a thrown error', async () => {
    vi.spyOn(api, 'getCheckRuns').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.degraded).toBe('transient'); // non-ApiError → transient
  });

  it.each([401, 403])('classifies a %s ApiError as auth-degraded', async (status) => {
    vi.spyOn(api, 'getCheckRuns').mockRejectedValue(new ApiError(status, null, null));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.degraded).toBe('auth');
  });

  it('keeps the last-known list (no error screen) when a later poll fails', async () => {
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(
        resp({
          checks: [mkCheck({ status: 'in-progress', conclusion: null })],
        }),
      )
      .mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.checks).toHaveLength(1);
    // The next poll (15s) fails — but a valid list is already on screen.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(result.current.degraded).toBe('transient'));
    expect(result.current.status).toBe('ok'); // stale list retained, NOT 'error'
    expect(result.current.checks).toHaveLength(1);
  });

  it('does NOT fetch again while the document is hidden (scope R1)', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(
      resp({
        checks: [mkCheck({ status: 'in-progress', conclusion: null })],
      }),
    );
    renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // hide the window AFTER activation; the next scheduled tick must no-op
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('resumes polling when the window becomes visible again (adversarial R2)', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(
      resp({
        checks: [mkCheck({ status: 'in-progress', conclusion: null })],
      }),
    );
    renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(1); // frozen while hidden
    // re-show → the visibilitychange listener restarts the loop
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(2));
  });

  it('stops polling when active toggles to false (scope R2)', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(
      resp({
        checks: [mkCheck({ status: 'in-progress', conclusion: null })],
      }),
    );
    const { rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a), {
      initialProps: { a: true },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ a: false }); // user navigates away from the Checks sub-tab
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(spy).toHaveBeenCalledTimes(1); // effect cleanup cancelled the loop
  });

  it('re-polls an empty list within the window, then stops after it elapses', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [] }));
    renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    // within the 2-min window: keeps re-polling on empty
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(spy).toHaveBeenCalledTimes(2);
    // advance past LATE_REGISTRATION_MS (120s); the loop must stop on still-empty
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120000);
    });
    const callsAfterWindow = spy.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(spy).toHaveBeenCalledTimes(callsAfterWindow); // plateaued
  });

  it('retry() restarts the loop after an error', async () => {
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(
        resp({
          checks: [mkCheck()],
        }),
      );
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('clears the prior head verdict on a new SHA (no stale tick across Reload)', async () => {
    vi.spyOn(api, 'getCheckRuns').mockImplementation((_pr, sha) =>
      Promise.resolve(
        sha === 'old'
          ? resp({
              headSha: 'old',
              checks: [mkCheck()],
            })
          : resp({ headSha: 'new', checks: [] }),
      ),
    );
    const { result, rerender } = renderHook(({ sha }) => useCheckRuns(PR, sha, true), {
      initialProps: { sha: 'old' },
    });
    await waitFor(() => expect(result.current.checks).toHaveLength(1)); // old head: green
    rerender({ sha: 'new' });
    // the old head's check list must NOT survive the SHA change
    await waitFor(() => expect(result.current.checks).toHaveLength(0));
  });

  it('refetch() fetches off-timer WITHOUT flipping status to loading (stale-while-revalidate)', async () => {
    const list = [mkCheck({ checkRunId: 1 })] as const;
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: list as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.refetch!()); // `!`: the hook always returns it (optional on the type)
    // status stays 'ok' (never transitions through 'loading')
    expect(result.current.status).toBe('ok');
    expect(result.current.checks).toHaveLength(1);
  });

  it('armRerunWatch keeps polling across the window even when all checks are terminal', async () => {
    const terminal = [mkCheck({ conclusion: 'failure', checkRunId: 42 })];
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockResolvedValue(resp({ checks: terminal as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    const callsAfterFirst = spy.mock.calls.length;

    act(() => result.current.armRerunWatch!(42)); // `!`: always returned (optional on the type)
    expect(result.current.rerunPendingFor).toBe(42);

    // advance one poll interval — without the watch, an all-terminal list stops polling
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(callsAfterFirst + 1);

    // advance past the watch window — the watch clears and polling stops
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(result.current.rerunPendingFor).toBeNull();
  });

  it('holds the cached list when a poll returns empty during a rerun-watch (no "No checks" flash)', async () => {
    const terminal = [mkCheck({ conclusion: 'failure', checkRunId: 42 })];
    // First poll: a real list. Every poll after: GitHub briefly reports ZERO check-runs while
    // it resets the suite for the rerun. The hook must keep the cached list on screen.
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(resp({ checks: terminal as never }))
      .mockResolvedValue(resp({ checks: [] }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.armRerunWatch!(42)); // kicks an immediate poll → empty
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(spy.mock.calls.length).toBeGreaterThan(1); // the empty poll(s) ran
    expect(result.current.status).toBe('ok'); // cached state held — NOT 'empty'
    expect(result.current.checks).toHaveLength(1); // still the cached check
  });

  it('accepts an empty list once the rerun-watch window has elapsed', async () => {
    const terminal = [mkCheck({ conclusion: 'failure', checkRunId: 42 })];
    vi.spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(resp({ checks: terminal as never }))
      .mockResolvedValue(resp({ checks: [] }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.armRerunWatch!(42));
    // Past the 90s watch: the suite never repopulated → empty is now the truth, surface it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(result.current.status).toBe('empty');
  });

  it('clears a stuck rerun-watch even when polls FAIL across the window (AC#3, failure path)', async () => {
    const terminal = [mkCheck({ conclusion: 'failure', checkRunId: 42 })];
    // First poll succeeds (warm series), every poll thereafter throws.
    vi.spyOn(api, 'getCheckRuns')
      .mockResolvedValueOnce(resp({ checks: terminal as never }))
      .mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.armRerunWatch!(42));
    expect(result.current.rerunPendingFor).toBe(42);

    // Every poll from here throws; advance past the 90s window. The expiry must fire on a
    // FAILING tick (the catch-branch updateRerunWatch), not only on a succeeding one.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(95_000);
    });
    expect(result.current.rerunPendingFor).toBeNull(); // would stay 42 without the catch fix
    expect(result.current.status).toBe('ok'); // warm series → stale list retained, NOT 'error'
  });

  it('does NOT extend the rerun-watch on focus-toggling — terminates at the fixed deadline (AC#3)', async () => {
    const terminal = [mkCheck({ conclusion: 'failure', checkRunId: 42 })];
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: terminal as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.armRerunWatch!(42));
    expect(result.current.rerunPendingFor).toBe(42);

    // Three hide→show cycles, each 40s (< the 90s window) but spanning ~123s of wall-clock.
    // A (buggy) re-arm-on-show would reset the deadline each return → it would NEVER expire and
    // rerunPendingFor would stay 42. With the fixed deadline it clears on a visible tick past 90s.
    for (let i = 0; i < 3; i++) {
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(40_000);
      });
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      await act(async () => {
        document.dispatchEvent(new Event('visibilitychange'));
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }
    expect(result.current.rerunPendingFor).toBeNull();
  });
});

// #743 — eager one-shot prefetch on PR-detail open; the poll loop stays tab-gated.
// shouldAdvanceTime is OFF here: the dwell-window assertions are exact-timing contracts and
// real-clock auto-advance would race them under CI load. Every advance is explicit; promise
// flushes ride advanceTimersByTimeAsync's microtask drains.
describe('useCheckRuns prefetch (#743)', () => {
  const DWELL = 300; // PREFETCH_DWELL_MS

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  const advance = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  it('fires exactly one fetch after the dwell and never starts the poll loop', async () => {
    // Non-terminal list — the POLL path would keep fetching; prefetch must not.
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockResolvedValue(resp({ checks: [mkCheck({ status: 'in-progress', conclusion: null })] }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, false, true));
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('ok');
    expect(result.current.checks).toHaveLength(1);
    await advance(60_000);
    expect(spy).toHaveBeenCalledTimes(1); // one-shot: no 15s loop
  });

  it('does not fetch while headSha is undefined', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp());
    const { result } = renderHook(() => useCheckRuns(PR, undefined, false, true));
    await advance(1_000);
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  it('hidden at mount: no fetch until the document becomes visible, then one', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [mkCheck()] }));
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    renderHook(() => useCheckRuns(PR, SHA, false, true));
    await advance(1_000);
    expect(spy).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a dwell-cancelled attempt costs zero requests and may retry later', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [mkCheck()] }));
    const { rerender } = renderHook(({ p }) => useCheckRuns(PR, SHA, false, p), {
      initialProps: { p: true },
    });
    await advance(100); // drive-by: leave before the dwell elapses
    rerender({ p: false });
    await advance(5_000);
    expect(spy).not.toHaveBeenCalled(); // the pending dwell timer was cleared, nothing issued
    rerender({ p: true }); // come back — the attempt was never burned
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('an aborted in-flight prefetch never re-issues for the same head', async () => {
    let resolveFetch: ((v: ChecksResponse) => void) | undefined;
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockImplementation(() => new Promise((r) => (resolveFetch = r)));
    const { rerender } = renderHook(({ p }) => useCheckRuns(PR, SHA, false, p), {
      initialProps: { p: true },
    });
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(1); // issued, in flight
    rerender({ p: false }); // abort mid-flight
    rerender({ p: true });
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1); // mark set at request start — no retry (AC 5)
    expect(resolveFetch).toBeDefined();
  });

  it('activation after a successful prefetch keeps the list, revalidates, and polls', async () => {
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockImplementation((_pr, sha) =>
        Promise.resolve(
          resp({ headSha: sha, checks: [mkCheck({ status: 'in-progress', conclusion: null })] }),
        ),
      );
    const { result, rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: false },
    });
    await advance(DWELL);
    expect(result.current.status).toBe('ok');
    rerender({ a: true });
    expect(result.current.status).toBe('ok'); // no loading flash (AC 3)
    expect(result.current.checks).toHaveLength(1); // list preserved
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2); // activation revalidate
    expect(result.current.status).toBe('ok');
    await advance(15_000);
    expect(spy).toHaveBeenCalledTimes(3); // poll loop live for the non-terminal list
  });

  it('a new headSha prefetches again; same head never refetches on prop flips', async () => {
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockImplementation((_pr, sha) => Promise.resolve(resp({ headSha: sha, checks: [] })));
    const { rerender } = renderHook(({ sha }) => useCheckRuns(PR, sha, false, true), {
      initialProps: { sha: 'abc' },
    });
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender({ sha: 'abc' }); // same head re-render
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender({ sha: 'def' });
    await advance(DWELL);
    expect(spy).toHaveBeenCalledTimes(2); // one issued request per head (AC 4)
  });

  it('does NOT re-arm the late window on RE-activation of an empty series', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [] }));
    const { rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, false), {
      initialProps: { a: true }, // manual Checks visit — no prefetch involved
    });
    await advance(125_000); // drain the full late-registration window; the loop stops
    const drained = spy.mock.calls.length;
    rerender({ a: false });
    rerender({ a: true }); // tab away and back on the SAME series
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(drained + 1); // one revalidating tick — today's behavior
    // The expired window must STAY expired: no renewed 15s polling per re-visit.
    await advance(45_000);
    expect(spy).toHaveBeenCalledTimes(drained + 1);
  });

  it('keeps the error card (no loading flash) when re-activating a cold failed series', async () => {
    let resolveRetry: ((v: ChecksResponse) => void) | undefined;
    vi.spyOn(api, 'getCheckRuns')
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise((r) => (resolveRetry = r)));
    const { result, rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, false), {
      initialProps: { a: true }, // manual cold visit fails → persistent error card
    });
    await advance(0);
    expect(result.current.status).toBe('error');
    rerender({ a: false });
    rerender({ a: true }); // re-visit the SAME series
    await advance(0);
    // Silent retry behind the still-visible error card — never a skeleton flash (re-visit
    // is not the series' first activation; the AC 5 loading reset must not re-fire).
    expect(result.current.status).toBe('error');
    await act(async () => {
      resolveRetry!(resp({ checks: [mkCheck()] }));
    });
    expect(result.current.status).toBe('ok');
  });

  it('an issued-but-unfinished poll fetch still closes the prefetch gate', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockImplementation(() => new Promise(() => {})); // never resolves; abort discards it
    const { rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: true }, // deep link straight onto Checks; tick issues a request
    });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1);
    rerender({ a: false }); // switch away before the response; cleanup aborts the fetch
    await advance(5_000);
    // The gate closes on ISSUE, not on success — no second request for the same head.
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('a successful poll fetch closes the prefetch gate for that head', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [mkCheck()] }));
    const { rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: true }, // deep link straight onto the Checks tab
    });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(1); // poll-path fetch, terminal list → loop stops
    rerender({ a: false }); // leave the tab; prefetch gate opens
    await advance(5_000);
    expect(spy).toHaveBeenCalledTimes(1); // tick success marked the head — no redundant prefetch
  });

  it('prefetch failure stays on loading (never pre-surfaces error); activation retries', async () => {
    let resolveSecond: ((v: ChecksResponse) => void) | undefined;
    const spy = vi
      .spyOn(api, 'getCheckRuns')
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise((r) => (resolveSecond = r)));
    const { result, rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: false },
    });
    await advance(DWELL);
    // A failed prefetch must NOT park the series on 'error': the tab is unmounted, and the
    // first activation would paint the error card for a frame before the latch's post-mount
    // loading reset. The series stays on 'loading' with the classification recorded (AC 5).
    expect(result.current.status).toBe('loading');
    expect(result.current.degraded).toBe('transient');
    rerender({ a: true });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2);
    // First-ever visit renders the cold-open sequence: skeleton while the retry is in flight.
    expect(result.current.status).toBe('loading');
    await act(async () => {
      resolveSecond!(resp({ checks: [mkCheck()] }));
    });
    expect(result.current.status).toBe('ok');
  });

  it('the activation retry after a failed prefetch surfaces error only if IT fails', async () => {
    vi.spyOn(api, 'getCheckRuns').mockRejectedValue(new Error('boom'));
    const { result, rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: false },
    });
    await advance(DWELL);
    expect(result.current.status).toBe('loading'); // failed prefetch: no pre-surfaced error
    rerender({ a: true });
    await advance(0);
    expect(result.current.status).toBe('error'); // the tick's own cold arm owns the surface
  });

  it('re-arms the late-registration window on activation of a still-empty series', async () => {
    const spy = vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: [] }));
    const { result, rerender } = renderHook(({ a }) => useCheckRuns(PR, SHA, a, true), {
      initialProps: { a: false },
    });
    await advance(DWELL);
    expect(result.current.status).toBe('empty');
    expect(spy).toHaveBeenCalledTimes(1); // prefetch is one-shot: no empty-list re-poll
    await advance(125_000); // the window measured from PREFETCH time has fully elapsed
    rerender({ a: true });
    await advance(0);
    expect(spy).toHaveBeenCalledTimes(2); // activation tick
    // Without the re-arm the expired window stops the loop here; the user must get the
    // full empty-list grace measured from ACTIVATION (AC 6).
    await advance(15_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('glyphChecks holds the previous head across a SHA change until new data lands', async () => {
    let resolveDef: ((v: ChecksResponse) => void) | undefined;
    vi.spyOn(api, 'getCheckRuns').mockImplementation((_pr, sha) =>
      sha === 'abc'
        ? Promise.resolve(resp({ headSha: 'abc', checks: [mkCheck()] }))
        : new Promise((r) => (resolveDef = r)),
    );
    const { result, rerender } = renderHook(({ sha }) => useCheckRuns(PR, sha, false, true), {
      initialProps: { sha: 'abc' },
    });
    await advance(DWELL);
    expect(result.current.glyphChecks).toHaveLength(1);
    rerender({ sha: 'def' });
    await advance(DWELL); // def's request issued, still pending
    expect(result.current.checks).toHaveLength(0); // series cleared as today
    expect(result.current.glyphChecks).toHaveLength(1); // glyph continuity (AC 7)
    await act(async () => {
      resolveDef!(resp({ headSha: 'def', checks: [] }));
    });
    expect(result.current.glyphChecks).toHaveLength(0); // new truth replaces the hold
  });
});
