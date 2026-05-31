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

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiHunkAnnotations.getAiHunkAnnotations).not.toHaveBeenCalled();
  });

  it('fetches and returns HunkAnnotation[] when enabled', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue([
      { path: 'src/Calc.cs', hunkIndex: 0, body: 'Reads cleaner.', tone: 'calm' },
    ]);

    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].tone).toBe('calm');
  });

  it('returns null on 204', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockResolvedValue(null);
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(aiHunkAnnotations.getAiHunkAnnotations).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error', async () => {
    vi.mocked(aiHunkAnnotations.getAiHunkAnnotations).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiHunkAnnotations(PR_REF, true));
    await waitFor(() => expect(aiHunkAnnotations.getAiHunkAnnotations).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });
});
