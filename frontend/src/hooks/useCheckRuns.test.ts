// frontend/src/hooks/useCheckRuns.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useCheckRuns } from './useCheckRuns';
import * as api from '../api/checks';
import { ApiError } from '../api/client';
import type { ChecksResponse } from '../api/types';

const PR = { owner: 'o', repo: 'r', number: 1 };
const SHA = 'abc';

function resp(over: Partial<ChecksResponse> = {}): ChecksResponse {
  return { checks: [], headSha: SHA, degraded: 'none', ...over };
}

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
        checks: [
          {
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
          },
        ],
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
          checks: [
            {
              name: 'b',
              status: 'in-progress',
              conclusion: null,
              source: 'check-run',
              startedAt: null,
              completedAt: null,
              detailsUrl: null,
              summary: null,
              appName: null,
              body: null,
              checkRunId: null,
            },
          ],
        }),
      )
      .mockResolvedValue(
        resp({
          checks: [
            {
              name: 'b',
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
            },
          ],
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
          checks: [
            {
              name: 'b',
              status: 'in-progress',
              conclusion: null,
              source: 'check-run',
              startedAt: null,
              completedAt: null,
              detailsUrl: null,
              summary: null,
              appName: null,
              body: null,
              checkRunId: null,
            },
          ],
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
        checks: [
          {
            name: 'b',
            status: 'in-progress',
            conclusion: null,
            source: 'check-run',
            startedAt: null,
            completedAt: null,
            detailsUrl: null,
            summary: null,
            appName: null,
            body: null,
            checkRunId: null,
          },
        ],
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
        checks: [
          {
            name: 'b',
            status: 'in-progress',
            conclusion: null,
            source: 'check-run',
            startedAt: null,
            completedAt: null,
            detailsUrl: null,
            summary: null,
            appName: null,
            body: null,
            checkRunId: null,
          },
        ],
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
        checks: [
          {
            name: 'b',
            status: 'in-progress',
            conclusion: null,
            source: 'check-run',
            startedAt: null,
            completedAt: null,
            detailsUrl: null,
            summary: null,
            appName: null,
            body: null,
            checkRunId: null,
          },
        ],
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
          checks: [
            {
              name: 'b',
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
            },
          ],
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
              checks: [
                {
                  name: 'b',
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
                },
              ],
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
    const list = [
      {
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
        checkRunId: 1,
      },
    ] as const;
    vi.spyOn(api, 'getCheckRuns').mockResolvedValue(resp({ checks: list as never }));
    const { result } = renderHook(() => useCheckRuns(PR, SHA, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));

    act(() => result.current.refetch!()); // `!`: the hook always returns it (optional on the type)
    // status stays 'ok' (never transitions through 'loading')
    expect(result.current.status).toBe('ok');
    expect(result.current.checks).toHaveLength(1);
  });

  it('armRerunWatch keeps polling across the window even when all checks are terminal', async () => {
    const terminal = [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        source: 'check-run',
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        summary: null,
        appName: null,
        body: null,
        checkRunId: 42,
      },
    ];
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
    const terminal = [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        source: 'check-run',
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        summary: null,
        appName: null,
        body: null,
        checkRunId: 42,
      },
    ];
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
    const terminal = [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        source: 'check-run',
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        summary: null,
        appName: null,
        body: null,
        checkRunId: 42,
      },
    ];
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
    const terminal = [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        source: 'check-run',
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        summary: null,
        appName: null,
        body: null,
        checkRunId: 42,
      },
    ];
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
    const terminal = [
      {
        name: 'build',
        status: 'completed',
        conclusion: 'failure',
        source: 'check-run',
        startedAt: null,
        completedAt: null,
        detailsUrl: null,
        summary: null,
        appName: null,
        body: null,
        checkRunId: 42,
      },
    ];
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
