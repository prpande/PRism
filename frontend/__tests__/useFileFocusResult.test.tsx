import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useFileFocusResult } from '../src/hooks/useFileFocusResult';
import * as api from '../src/api/aiFileFocus';

vi.mock('../src/api/aiFileFocus');
const PR = { owner: 'octo', repo: 'repo', number: 1 };

describe('useFileFocusResult', () => {
  beforeEach(() => vi.mocked(api.getAiFileFocusResult).mockReset());

  it('not-subscribed (Live, not subscribed) without fetching', () => {
    const { result } = renderHook(() => useFileFocusResult(PR, true, false));
    expect(result.current.status).toBe('not-subscribed');
    expect(api.getAiFileFocusResult).not.toHaveBeenCalled();
  });

  it('disabled → not-subscribed-equivalent off (no fetch)', () => {
    const { result } = renderHook(() => useFileFocusResult(PR, false, true));
    expect(result.current.status).toBe('no-changes');
    expect(api.getAiFileFocusResult).not.toHaveBeenCalled();
  });

  it('ok when entries contain high/medium', async () => {
    vi.mocked(api.getAiFileFocusResult).mockResolvedValue({
      kind: 'ok',
      result: { entries: [{ path: 'a', level: 'high', rationale: 'x' }], fallback: false },
    });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(result.current.entries).toHaveLength(1);
  });

  it('empty when entries present but none high/medium', async () => {
    vi.mocked(api.getAiFileFocusResult).mockResolvedValue({
      kind: 'ok',
      result: { entries: [{ path: 'a', level: 'low', rationale: 'x' }], fallback: false },
    });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('empty'));
  });

  it('fallback flag → fallback status (checked before entries)', async () => {
    vi.mocked(api.getAiFileFocusResult).mockResolvedValue({
      kind: 'ok',
      result: { entries: [{ path: 'a', level: 'medium', rationale: 'x' }], fallback: true },
    });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('fallback'));
  });

  it('no-changes on 204', async () => {
    vi.mocked(api.getAiFileFocusResult).mockResolvedValue({ kind: 'no-content' });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('no-changes'));
  });

  it('error on failure', async () => {
    vi.mocked(api.getAiFileFocusResult).mockResolvedValue({ kind: 'error' });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('error'));
  });

  it('retry() re-issues the GET', async () => {
    vi.mocked(api.getAiFileFocusResult)
      .mockResolvedValueOnce({ kind: 'error' })
      .mockResolvedValueOnce({
        kind: 'ok',
        result: { entries: [{ path: 'a', level: 'high', rationale: 'x' }], fallback: false },
      });
    const { result } = renderHook(() => useFileFocusResult(PR, true, true));
    await waitFor(() => expect(result.current.status).toBe('error'));
    act(() => result.current.retry());
    await waitFor(() => expect(result.current.status).toBe('ok'));
    expect(api.getAiFileFocusResult).toHaveBeenCalledTimes(2);
  });
});
