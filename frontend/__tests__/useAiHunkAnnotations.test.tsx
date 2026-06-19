import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiHunkAnnotations } from '../src/hooks/useAiHunkAnnotations';
import * as aiHunkAnnotations from '../src/api/aiHunkAnnotations';

vi.mock('../src/api/aiHunkAnnotations');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiHunkAnnotations', () => {
  beforeEach(() => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockReset();
  });

  it('returns empty state when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, false));
    expect(result.current.state).toBe('empty');
    expect(result.current.annotations).toBeNull();
    expect(aiHunkAnnotations.getAiHunkAnnotations).not.toHaveBeenCalled();
  });

  it('fetches and returns ready state with HunkAnnotation[] when enabled', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue([
      { path: 'src/Calc.cs', hunkIndex: 0, body: 'Reads cleaner.', tone: 'calm' },
    ]);

    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.annotations).toHaveLength(1);
    expect(result.current.annotations?.[0].tone).toBe('calm');
  });

  it('returns empty state on 204', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue(null);
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('empty'));
    expect(result.current.annotations).toBeNull();
  });

  it('returns error state on network error', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('error'));
    expect(result.current.annotations).toBeNull();
  });
});
