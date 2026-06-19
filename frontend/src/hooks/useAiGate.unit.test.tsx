import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AiCapabilities, AiMode } from '../api/types';

const mock = vi.hoisted(() => ({ caps: null as AiCapabilities | null, aiMode: 'off' as AiMode }));

vi.mock('./useCapabilities', () => ({ useCapabilities: () => ({ capabilities: mock.caps }) }));
vi.mock('./usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));

import { useAiGate, useIsSampleMode } from './useAiGate';

const allTrue: AiCapabilities = {
  summary: true,
  fileFocus: true,
  hunkAnnotations: true,
  preSubmitValidators: true,
  composerAssist: true,
  draftSuggestions: true,
  draftReconciliation: true,
  inboxEnrichment: true,
  inboxRanking: true,
};

beforeEach(() => {
  mock.caps = null;
  mock.aiMode = 'off';
});

describe('useAiGate two-factor seam', () => {
  it('is false when capability is false even if mode !== off (locks the D112 shape)', () => {
    mock.caps = { ...allTrue, summary: false };
    mock.aiMode = 'preview';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });
  it('is false when mode is off even if capability is true', () => {
    mock.caps = allTrue;
    mock.aiMode = 'off';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });
  it('is true only when capability is true and mode !== off', () => {
    mock.caps = allTrue;
    mock.aiMode = 'preview';
    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(true);
  });
});

describe('useIsSampleMode', () => {
  it.each([
    ['off', false],
    ['preview', true],
    ['live', false],
  ] as const)('returns %s -> %s', (m, expected) => {
    mock.aiMode = m;
    const { result } = renderHook(() => useIsSampleMode());
    expect(result.current).toBe(expected);
  });
});
