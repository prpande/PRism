import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiSummary } from './useAiSummary';
import * as api from '../api/aiSummary';

vi.mock('../api/aiSummary');
const pr = { owner: 'o', repo: 'r', number: 1 };

describe('useAiSummary', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stays idle until subscribed', async () => {
    const spy = vi.spyOn(api, 'getAiSummaryResult');
    const { result } = renderHook(() => useAiSummary(pr, true, /* subscribed */ false));
    expect(result.current).toEqual({ summary: null, loading: false, error: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it('loads then resolves a summary when enabled + subscribed', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    const { result } = renderHook(() => useAiSummary(pr, true, true));
    await waitFor(() => expect(result.current.summary).toEqual({ body: 'b', category: 'fix' }));
    expect(result.current.error).toBe(false);
  });

  it('sets error on kind:error', async () => {
    vi.spyOn(api, 'getAiSummaryResult').mockResolvedValue({ kind: 'error' });
    const { result } = renderHook(() => useAiSummary(pr, true, true));
    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.summary).toBeNull();
  });
});
