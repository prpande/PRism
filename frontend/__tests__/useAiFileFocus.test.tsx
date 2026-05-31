import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useAiFileFocus } from '../src/hooks/useAiFileFocus';
import * as aiFileFocus from '../src/api/aiFileFocus';

vi.mock('../src/api/aiFileFocus');

const PR_REF = { owner: 'octo', repo: 'repo', number: 1 };

describe('useAiFileFocus', () => {
  beforeEach(() => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockReset();
  });

  it('returns null when disabled (no fetch)', () => {
    const { result } = renderHook(() => useAiFileFocus(PR_REF, false));
    expect(result.current).toBe(null);
    expect(aiFileFocus.getAiFileFocus).not.toHaveBeenCalled();
  });

  it('fetches and returns FileFocus[] when enabled', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockResolvedValue([
      { path: 'src/Calc.cs', level: 'high' },
      { path: 'src/Calc.Tests.cs', level: 'medium' },
    ]);

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    await waitFor(() => expect(result.current).not.toBe(null));
    expect(result.current).toHaveLength(2);
    expect(result.current?.[0].path).toBe('src/Calc.cs');
    expect(result.current?.[0].level).toBe('high');
  });

  it('returns null on 204 (empty seam → null sentinel)', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockResolvedValue(null);

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    await waitFor(() => expect(aiFileFocus.getAiFileFocus).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('returns null on network error (silent failure matches useAiSummary precedent)', async () => {
    vi.mocked(aiFileFocus.getAiFileFocus).mockRejectedValue(new Error('boom'));

    const { result } = renderHook(() => useAiFileFocus(PR_REF, true));
    await waitFor(() => expect(aiFileFocus.getAiFileFocus).toHaveBeenCalled());
    expect(result.current).toBe(null);
  });

  it('does not set state after unmount (cancelled cleanup)', async () => {
    let resolve!: (
      value: ReturnType<typeof aiFileFocus.getAiFileFocus> extends Promise<infer R> ? R : never,
    ) => void;
    vi.mocked(aiFileFocus.getAiFileFocus).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );

    const { result, unmount } = renderHook(() => useAiFileFocus(PR_REF, true));
    unmount();
    resolve([{ path: 'src/Calc.cs', level: 'high' }]);
    // No React warning about setState on unmounted component
    expect(result.current).toBe(null);
  });
});
