import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiMode } from '../api/types';

// Drives useCapabilities' local derivation directly off a mocked aiMode.
const mock = vi.hoisted(() => ({ aiMode: 'off' as AiMode, hasUi: true }));
vi.mock('./usePreferences', () => ({
  usePreferences: () => ({
    preferences: mock.hasUi ? { ui: { aiMode: mock.aiMode } } : undefined,
    error: null,
  }),
}));

import { useCapabilities } from './useCapabilities';

beforeEach(() => {
  mock.aiMode = 'off';
  mock.hasUi = true;
});

describe('useCapabilities tri-state derivation', () => {
  it('is null until the shared preferences store loads a well-formed ui', () => {
    mock.hasUi = false;
    const { result } = renderHook(() => useCapabilities());
    expect(result.current.capabilities).toBeNull();
  });

  it('Off → every capability false', () => {
    mock.aiMode = 'off';
    const { result } = renderHook(() => useCapabilities());
    expect(result.current.capabilities).toMatchObject({
      summary: false,
      composerAssist: false,
      inboxRanking: false,
    });
  });

  it('Preview → every capability true (all surfaces show SAMPLE content)', () => {
    mock.aiMode = 'preview';
    const { result } = renderHook(() => useCapabilities());
    expect(result.current.capabilities).toMatchObject({
      summary: true,
      composerAssist: true,
      preSubmitValidators: true,
      inboxRanking: true,
    });
  });

  it('Live → only `summary` (the sole registered live seam in P1); not-yet-live seams stay off', () => {
    mock.aiMode = 'live';
    const { result } = renderHook(() => useCapabilities());
    // The regression: a two-state `aiMode === 'preview' ? AllOn : AllOff` derivation
    // returned AllOff for Live, gating the live summary card off entirely.
    expect(result.current.capabilities?.summary).toBe(true);
    expect(result.current.capabilities).toMatchObject({
      composerAssist: false,
      preSubmitValidators: false,
      fileFocus: false,
      hunkAnnotations: false,
      draftSuggestions: false,
      inboxEnrichment: false,
    });
  });
});
