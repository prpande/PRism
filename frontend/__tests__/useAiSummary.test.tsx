import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useAiSummary } from '../src/hooks/useAiSummary';
import * as api from '../src/api/aiSummary';
import type { PrReference, PrSummary } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const otherRef: PrReference = { owner: 'octocat', repo: 'hello', number: 43 };

const sampleSummary: PrSummary = { body: 'Refactor the lease loop.', category: 'Refactor' };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAiSummary', () => {
  it('returns null and never calls the API when enabled is false', async () => {
    const spy = vi.spyOn(api, 'getAiSummary').mockResolvedValue(sampleSummary);
    const { result } = renderHook(() => useAiSummary(ref, false));
    // Tick a microtask boundary so any incidental effect runs.
    await Promise.resolve();
    expect(result.current).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches and returns the summary when enabled flips to true', async () => {
    vi.spyOn(api, 'getAiSummary').mockResolvedValue(sampleSummary);
    const { result } = renderHook(() => useAiSummary(ref, true));
    await waitFor(() => expect(result.current).toEqual(sampleSummary));
  });

  it('silently swallows fetch rejections and stays at null (best-effort cosmetic)', async () => {
    const spy = vi.spyOn(api, 'getAiSummary').mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiSummary(ref, true));
    // Wait long enough for the rejection to settle.
    await waitFor(() => expect(spy).toHaveBeenCalled());
    // Microtask boundary so the .catch handler runs.
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toBeNull();
  });

  it('clears the summary back to null when enabled flips from true to false', async () => {
    vi.spyOn(api, 'getAiSummary').mockResolvedValue(sampleSummary);
    const { result, rerender } = renderHook(({ enabled }) => useAiSummary(ref, enabled), {
      initialProps: { enabled: true },
    });
    await waitFor(() => expect(result.current).toEqual(sampleSummary));
    rerender({ enabled: false });
    await waitFor(() => expect(result.current).toBeNull());
  });

  it('does not write a stale summary into the new prRef after rapid PR navigation', async () => {
    // Hold the first request open; the second request lands first. Without
    // the cancelled-flag guard, the late-resolving first request would
    // overwrite the second's result. This test pins that guard.
    let resolveFirst: (s: PrSummary) => void = () => undefined;
    const firstPending = new Promise<PrSummary>((res) => {
      resolveFirst = res;
    });
    const secondSummary: PrSummary = { body: 'Second PR summary.', category: 'Feature' };
    const spy = vi.spyOn(api, 'getAiSummary').mockImplementation((prRef) => {
      if (prRef.number === ref.number) return firstPending;
      return Promise.resolve(secondSummary);
    });
    const { result, rerender } = renderHook(({ prRef }) => useAiSummary(prRef, true), {
      initialProps: { prRef: ref },
    });
    // Rerender with otherRef before the first promise resolves — the cleanup
    // function flips cancelled=true on the first effect run.
    rerender({ prRef: otherRef });
    await waitFor(() => expect(result.current).toEqual(secondSummary));
    // Now resolve the first request — its result must NOT replace the second.
    resolveFirst({ body: 'Stale first PR summary.', category: 'Stale' });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current).toEqual(secondSummary);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
