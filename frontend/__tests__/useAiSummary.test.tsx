import { renderHook, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAiSummary } from '../src/hooks/useAiSummary';
import * as api from '../src/api/aiSummary';
import type { PrReference } from '../src/api/types';

// Legacy mirror of the co-located src/hooks/useAiSummary.test.ts.
// Kept for coverage completeness in the __tests__/ tree. Authoritative
// tests live in the co-located file; update both trees together.

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const otherRef: PrReference = { owner: 'octocat', repo: 'hello', number: 43 };

vi.mock('../src/api/aiSummary');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('useAiSummary', () => {
  it('returns idle state and never calls the API when enabled is false', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(ref, false, false, false));
    await Promise.resolve();
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('stays idle until subscribed even if enabled', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(ref, true, false, false));
    await Promise.resolve();
    expect(result.current.summary).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches and returns the summary when enabled and subscribed', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'Refactor the lease loop.', category: 'Refactor' },
    });
    const { result } = renderHook(() => useAiSummary(ref, true, true, false));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.summary).toEqual({
      body: 'Refactor the lease loop.',
      category: 'Refactor',
    });
    expect(result.current.error).toBe(false);
  });

  it('sets error=true when result is kind:error', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'error',
      reason: 'provider-error',
    });
    const { result } = renderHook(() => useAiSummary(ref, true, true, false));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toBeNull();
  });

  it('returns idle state when kind:absent (204)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'absent' });
    const { result } = renderHook(() => useAiSummary(ref, true, true, false));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.summary).toBeNull();
    expect(result.current.error).toBe(false);
  });

  it('does not write a stale summary into the new prRef after rapid PR navigation', async () => {
    let resolveFirst!: (r: { kind: 'ok'; summary: { body: string; category: string } }) => void;
    const firstPending = new Promise<{ kind: 'ok'; summary: { body: string; category: string } }>(
      (res) => {
        resolveFirst = res;
      },
    );
    const secondSummary = { body: 'Second PR summary.', category: 'Feature' };
    vi.spyOn(api, 'getAiSummaryResult').mockImplementation((prRef) => {
      if (prRef.number === ref.number) return firstPending;
      return Promise.resolve({ kind: 'ok', summary: secondSummary });
    });
    const { result, rerender } = renderHook(({ prRef }) => useAiSummary(prRef, true, true, false), {
      initialProps: { prRef: ref },
    });
    rerender({ prRef: otherRef });
    await waitFor(() => expect(result.current.summary).toEqual(secondSummary));
    resolveFirst({ kind: 'ok', summary: { body: 'Stale first PR summary.', category: 'Stale' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.summary).toEqual(secondSummary);
  });

  it('is not stale until baseShaChanged is true', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    const { result, rerender } = renderHook(
      ({ baseChanged }) => useAiSummary(ref, true, true, baseChanged),
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
    let resolveFetch!: (r: { kind: 'ok'; summary: { body: string; category: string } }) => void;
    const pending = new Promise<{ kind: 'ok'; summary: { body: string; category: string } }>(
      (res) => {
        resolveFetch = res;
      },
    );
    vi.spyOn(api, 'getAiSummaryResult').mockReturnValue(pending);
    const { result, rerender } = renderHook(
      ({ baseChanged }) => useAiSummary(ref, true, true, baseChanged),
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
      ({ baseChanged }) => useAiSummary(ref, true, true, baseChanged),
      { initialProps: { baseChanged: false } },
    );
    await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    rerender({ baseChanged: true });
    await Promise.resolve();
    expect(spy).toHaveBeenCalledTimes(1); // no extra GET on a base-change event
  });

  it('regenerate() POSTs, replaces the summary on 200, and clears staleness', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'old', category: 'fix' },
    });
    const regen = vi
      .spyOn(api, 'regenerateAiSummary')
      .mockResolvedValue({ kind: 'ok', summary: { body: 'new', category: 'fix' } });
    const { result } = renderHook(() => useAiSummary(ref, true, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.isStale).toBe(true);
    await act(async () => {
      await result.current.regenerate();
    });
    expect(regen).toHaveBeenCalledTimes(1);
    expect(result.current.summary).toEqual({ body: 'new', category: 'fix' });
    expect(result.current.isStale).toBe(false);
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
    const { result } = renderHook(() => useAiSummary(ref, true, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    await act(async () => {
      await result.current.regenerate();
    });
    expect(result.current.summary).toEqual({ body: 'old', category: 'fix' }); // body retained
    expect(result.current.regenerateError).toBe(true);
  });
});
