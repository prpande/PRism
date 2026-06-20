import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAiSummary } from './useAiSummary';
import { AiFailureProvider, useAiFailure } from '../components/Ai/aiFailure';
import * as api from '../api/aiSummary';

vi.mock('../api/aiSummary');
const pr = { owner: 'o', repo: 'r', number: 1 };

type OkResult = { kind: 'ok'; summary: { body: string; category: string } };
// A promise whose resolver is exposed, so a test can hold a fetch in-flight and
// resolve it on cue. Used by the mid-fetch and clear-then-fetch cases below.
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('useAiSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays idle until subscribed', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(pr, true, /* subscribed */ false, false));
    expect(result.current).toEqual({
      summary: null,
      loading: false,
      error: false,
      isStale: false,
      regenerating: false,
      regenerateError: false,
      regenerate: expect.any(Function),
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it('loads then resolves a summary when enabled + subscribed', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false));
    await waitFor(() => expect(result.current.summary).toEqual({ body: 'b', category: 'fix' }));
    expect(result.current.error).toBe(false);
  });

  it('sets error on kind:error', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'error',
      reason: 'provider-error',
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toBeNull();
  });

  it('is not stale until baseShaChanged is true', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    const { result, rerender } = renderHook(
      ({ baseChanged }) => useAiSummary(pr, true, true, baseChanged),
      { initialProps: { baseChanged: false } },
    );
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(false);
    rerender({ baseChanged: true });
    expect(result.current.isStale).toBe(true);
  });

  it('keeps staleness when a base change arrives mid-fetch (baseShaChangedRef guard)', async () => {
    // The base change lands WHILE the initial GET is in-flight. When the fetch resolves, the
    // .then() must see baseShaChangedRef.current === true and skip setStaleCleared(true), so the
    // freshly-fetched summary is still flagged stale (it was already superseded on the server).
    const { promise: pending, resolve: resolveFetch } = deferred<OkResult>();
    vi.spyOn(api, 'getAiSummaryResult').mockReturnValue(pending);
    const { result, rerender } = renderHook(
      ({ baseChanged }) => useAiSummary(pr, true, true, baseChanged),
      { initialProps: { baseChanged: false } },
    );
    // Base change arrives before the in-flight fetch resolves.
    rerender({ baseChanged: true });
    await act(async () => {
      resolveFetch({ kind: 'ok', summary: { body: 'b', category: 'fix' } });
      await pending;
    });
    expect(result.current.summary).toEqual({ body: 'b', category: 'fix' });
    expect(result.current.isStale).toBe(true); // mid-fetch base change must not be cleared
  });

  it('does NOT auto-refetch when baseShaChanged flips (token discipline)', async () => {
    const spy = vi
      .spyOn(api, 'getAiSummaryResult')
      .mockResolvedValue({ kind: 'ok', summary: { body: 'b', category: 'fix' } });
    const { rerender } = renderHook(
      ({ baseChanged }) => useAiSummary(pr, true, true, baseChanged),
      { initialProps: { baseChanged: false } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ baseChanged: true });
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1); // no extra GET on a base-change event
  });

  // #464 — toggling AI on for an ALREADY-MOUNTED PR refreshes the summary in place (AC1). The hook
  // is keyed on `enabled`, so flipping it false→true (the Settings AI-mode toggle, propagated via the
  // shared prefs store → useAiGate) re-runs the fetch effect without a remount/reopen.
  it('#464: flipping enabled false→true on a mounted PR fetches in place (no reopen)', async () => {
    const spy = vi
      .spyOn(api, 'getAiSummaryResult')
      .mockResolvedValue({ kind: 'ok', summary: { body: 'b', category: 'fix' } });
    const { result, rerender } = renderHook(
      ({ enabled }) => useAiSummary(pr, enabled, true, false),
      { initialProps: { enabled: false } },
    );
    // AI off: no fetch, nothing rendered.
    expect(spy).not.toHaveBeenCalled();
    expect(result.current.summary).toBeNull();
    // Toggle AI on — must fetch in place.
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.summary).toEqual({ body: 'b', category: 'fix' }));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  // #464 — turning AI off clears the summary immediately, so a stale body can never linger while off.
  it('#464: turning AI off clears the summary (no stale content while off)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    const { result, rerender } = renderHook(
      ({ enabled }) => useAiSummary(pr, enabled, true, false),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    rerender({ enabled: false });
    expect(result.current.summary).toBeNull();
  });

  // #464 — clear-then-fetch (AC2): when the PR ref changes, the prior PR's summary is cleared BEFORE
  // the new PR's fetch resolves — so another PR's content is never shown, even transiently. (In the app
  // each PR has its own keep-alive hook instance keyed by prRefKey; this pins the hook's own keying as
  // a defense-in-depth guard against any cross-PR bleed.)
  it('#464: changing prRef clears the prior summary before the new one resolves', async () => {
    const { promise: pendingB, resolve: resolveB } = deferred<OkResult>();
    vi.spyOn(api, 'getAiSummaryResult').mockImplementation((ref) =>
      ref.number === 1
        ? Promise.resolve({ kind: 'ok' as const, summary: { body: 'A-summary', category: 'fix' } })
        : pendingB,
    );
    const { result, rerender } = renderHook(({ p }) => useAiSummary(p, true, true, false), {
      initialProps: { p: { owner: 'o', repo: 'r', number: 1 } },
    });
    await waitFor(() =>
      expect(result.current.summary).toEqual({ body: 'A-summary', category: 'fix' }),
    );
    // Navigate to PR #2 — while #2's fetch is in flight, #1's summary MUST be cleared, never shown under #2.
    rerender({ p: { owner: 'o', repo: 'r', number: 2 } });
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(true);
    // #2 then resolves with its OWN content.
    await act(async () => {
      resolveB({ kind: 'ok', summary: { body: 'B-summary', category: 'feat' } });
      await pendingB;
    });
    expect(result.current.summary).toEqual({ body: 'B-summary', category: 'feat' });
  });

  it('regenerate() POSTs, replaces the summary on 200, and clears staleness', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'old', category: 'fix' },
    });
    const regen = vi
      .spyOn(api, 'regenerateAiSummary')
      .mockResolvedValue({ kind: 'ok', summary: { body: 'new', category: 'fix' } });
    const { result } = renderHook(() => useAiSummary(pr, true, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(true);
    await act(async () => {
      await result.current.regenerate();
    });
    expect(regen).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toEqual({ body: 'new', category: 'fix' });
    expect(result.current.isStale).toBe(false);
  });

  // #525 — cap-change staleness. A summary generated under a cap that no longer matches the live
  // configured cap is "Out of date" (Regenerate offered), detected by comparing the stamped
  // generatedMaxChars to the configuredMaxChars param.
  it('is stale when the generated cap differs from the configured cap', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix', generatedMaxChars: 1000 },
    });
    const { result } = renderHook(() =>
      useAiSummary(pr, true, true, false, /* configuredMaxChars */ 2000),
    );
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(true);
  });

  it('is NOT stale when the generated cap matches the configured cap', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix', generatedMaxChars: 1000 },
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false, 1000));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(false);
  });

  it('is NOT stale when the generated cap is null (legacy summary)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' }, // no generatedMaxChars
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false, 2000));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(false);
  });

  it('is NOT stale while the configured cap is still null (preferences-load window — no flicker)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix', generatedMaxChars: 1000 },
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false, null));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(false);
  });

  it('does NOT auto-refetch when the configured cap changes (render-time compare, token discipline)', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix', generatedMaxChars: 1000 },
    });
    const { result, rerender } = renderHook(({ cap }) => useAiSummary(pr, true, true, false, cap), {
      initialProps: { cap: 1000 as number | null },
    });
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    expect(result.current.isStale).toBe(false);
    rerender({ cap: 3000 }); // user changed the cap in Settings while this PR stayed open
    expect(result.current.isStale).toBe(true); // picked up without a refetch
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1); // NO extra GET
  });

  it('regenerate clears cap-change staleness (new summary restamps the current cap)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'old', category: 'fix', generatedMaxChars: 1000 },
    });
    vi.spyOn(api, 'regenerateAiSummary').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'new', category: 'fix', generatedMaxChars: 3000 },
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, false, 3000));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(true); // 1000 != 3000
    await act(async () => {
      await result.current.regenerate();
    });
    expect(result.current.summary).toEqual({
      body: 'new',
      category: 'fix',
      generatedMaxChars: 3000,
    });
    expect(result.current.isStale).toBe(false); // restamped to the live cap
  });

  it('regenerate() retains the present body on 503', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'old', category: 'fix' },
    });
    vi.spyOn(api, 'regenerateAiSummary').mockResolvedValue({
      kind: 'error',
      reason: 'provider-error',
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    await act(async () => {
      await result.current.regenerate();
    });
    expect(result.current.summary).toEqual({ body: 'old', category: 'fix' }); // body retained
    expect(result.current.regenerateError).toBe(true);
  });
});

// --- Failure reporting tests (use AiFailureProvider + MemoryRouter) ---

const FAIL_PR = { owner: 'o', repo: 'r', number: 1 } as const;
const failWrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter initialEntries={['/pr/o/r/1']}>
    <AiFailureProvider>{children}</AiFailureProvider>
  </MemoryRouter>
);

it('reports summary on initial-fetch kind:error', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
    kind: 'error',
    reason: 'provider-error',
  });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('summary'));
});

it('does NOT report on kind:auth; shows inline error instead', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'auth' });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  // Wait for the fetch to resolve and loading to complete.
  await waitFor(() => expect(result.current.s.loading).toBe(false));
  // Auth must NOT surface a toast failure (no global report).
  expect(result.current.f.activeFailedSeams).not.toContain('summary');
  // But auth DOES show the inline error block (pre-#484 parity; file-focus parity).
  expect(result.current.s.error).toBe(true);
});

it('regenerate failure reports; regenerate success clears', async () => {
  vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
    kind: 'error',
    reason: 'provider-error',
  }); // initial fetch fails → reports
  const regen = vi
    .spyOn(api, 'regenerateAiSummary')
    .mockResolvedValue({ kind: 'ok', summary: { body: 'new', category: 'fix' } });
  const { result } = renderHook(
    () => ({ s: useAiSummary(FAIL_PR, true, true, false), f: useAiFailure() }),
    { wrapper: failWrapper },
  );
  await waitFor(() => expect(result.current.f.activeFailedSeams).toContain('summary'));
  await act(async () => {
    await result.current.s.regenerate();
  }); // POST path → clears
  expect(result.current.f.activeFailedSeams).not.toContain('summary');
  expect(regen).toHaveBeenCalled();
});
