import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useAiSummary } from './useAiSummary';
import * as api from '../api/aiSummary';

vi.mock('../api/aiSummary');
const pr = { owner: 'o', repo: 'r', number: 1 };

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
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' });
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

  it('regenerate() retains the present body on 503', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'old', category: 'fix' },
    });
    vi.spyOn(api, 'regenerateAiSummary').mockResolvedValue({ kind: 'error' });
    const { result } = renderHook(() => useAiSummary(pr, true, true, true));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    await act(async () => {
      await result.current.regenerate();
    });
    expect(result.current.summary).toEqual({ body: 'old', category: 'fix' }); // body retained
    expect(result.current.regenerateError).toBe(true);
  });
});
