import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiDraftSuggestions } from '../src/hooks/useAiDraftSuggestions';
import * as aiDraftSuggestions from '../src/api/aiDraftSuggestions';

vi.mock('../src/api/aiDraftSuggestions');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiDraftSuggestions', () => {
  beforeEach(() => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockReset();
  });

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiDraftSuggestions.getAiDraftSuggestions).not.toHaveBeenCalled();
  });

  it('fetches and returns DraftSuggestion[] when enabled', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue([
      { filePath: 'src/Calc.cs', lineNumber: 5, body: 'Worth a comment here?' },
    ]);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(1);
    expect(result.current?.[0].filePath).toBe('src/Calc.cs');
    expect(result.current?.[0].lineNumber).toBe(5);
  });

  it('returns null on 204', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue(null);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(aiDraftSuggestions.getAiDraftSuggestions).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(aiDraftSuggestions.getAiDraftSuggestions).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });
});
