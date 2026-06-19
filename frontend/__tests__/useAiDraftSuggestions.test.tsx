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

  it('is empty when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, false));
    expect(result.current.state).toBe('empty');
    expect(result.current.suggestions).toBe(null);
    expect(aiDraftSuggestions.getAiDraftSuggestions).not.toHaveBeenCalled();
  });

  it('fetches and returns ready state with suggestions when enabled', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue([
      { filePath: 'src/Calc.cs', lineNumber: 5, body: 'Worth a comment here?' },
    ]);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.suggestions).toHaveLength(1);
    expect(result.current.suggestions?.[0].filePath).toBe('src/Calc.cs');
    expect(result.current.suggestions?.[0].lineNumber).toBe(5);
  });

  it('is empty on 204 (null result)', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockResolvedValue(null);
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('empty'));
  });

  it('is error on network error', async () => {
    vi.mocked(aiDraftSuggestions.getAiDraftSuggestions).mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useAiDraftSuggestions(PR_REF, true));
    await waitFor(() => expect(result.current.state).toBe('error'));
  });
});
