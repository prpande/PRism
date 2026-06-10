import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useAiSummary', () => {
  it('returns idle state and never calls the API when enabled is false', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(ref, false, false));
    await Promise.resolve();
    expect(result.current).toEqual({ summary: null, loading: false, error: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('stays idle until subscribed even if enabled', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(ref, true, false));
    await Promise.resolve();
    expect(result.current).toEqual({ summary: null, loading: false, error: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('fetches and returns the summary when enabled and subscribed', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'Refactor the lease loop.', category: 'Refactor' },
    });
    const { result } = renderHook(() => useAiSummary(ref, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.summary).toEqual({
      body: 'Refactor the lease loop.',
      category: 'Refactor',
    });
    expect(result.current.error).toBe(false);
  });

  it('sets error=true when result is kind:error', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' });
    const { result } = renderHook(() => useAiSummary(ref, true, true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toBeNull();
  });

  it('returns idle state when kind:absent (204)', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'absent' });
    const { result } = renderHook(() => useAiSummary(ref, true, true));
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
    const { result, rerender } = renderHook(({ prRef }) => useAiSummary(prRef, true, true), {
      initialProps: { prRef: ref },
    });
    rerender({ prRef: otherRef });
    await waitFor(() => expect(result.current.summary).toEqual(secondSummary));
    resolveFirst({ kind: 'ok', summary: { body: 'Stale first PR summary.', category: 'Stale' } });
    await Promise.resolve();
    await Promise.resolve();
    expect(result.current.summary).toEqual(secondSummary);
  });
});
