import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAiGate } from '../src/hooks/useAiGate';
import { useCapabilities } from '../src/hooks/useCapabilities';
import { usePreferences } from '../src/hooks/usePreferences';

vi.mock('../src/hooks/useCapabilities');
vi.mock('../src/hooks/usePreferences');

describe('useAiGate', () => {
  beforeEach(() => {
    vi.mocked(useCapabilities).mockReset();
    vi.mocked(usePreferences).mockReset();
  });

  it('returns false when both capability and aiPreview are off', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: false,
        fileFocus: false,
        hunkAnnotations: false,
        preSubmitValidators: false,
        composerAssist: false,
        draftSuggestions: false,
        draftReconciliation: false,
        inboxEnrichment: false,
        inboxRanking: false,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when capability is off but aiPreview is on', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: false,
        fileFocus: false,
        hunkAnnotations: false,
        preSubmitValidators: false,
        composerAssist: false,
        draftSuggestions: false,
        draftReconciliation: false,
        inboxEnrichment: false,
        inboxRanking: false,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when capability is on but aiPreview is off', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: true,
        fileFocus: true,
        hunkAnnotations: true,
        preSubmitValidators: true,
        composerAssist: true,
        draftSuggestions: true,
        draftReconciliation: true,
        inboxEnrichment: true,
        inboxRanking: true,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: false, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns true only when both capability and aiPreview are on', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: true,
        fileFocus: true,
        hunkAnnotations: true,
        preSubmitValidators: true,
        composerAssist: true,
        draftSuggestions: true,
        draftReconciliation: true,
        inboxEnrichment: true,
        inboxRanking: true,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(true);
  });

  it('returns false when capabilities is null (still loading)', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: null,
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('returns false when preferences is null (still loading)', () => {
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: true,
        fileFocus: true,
        hunkAnnotations: true,
        preSubmitValidators: true,
        composerAssist: true,
        draftSuggestions: true,
        draftReconciliation: true,
        inboxEnrichment: true,
        inboxRanking: true,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: null,
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    const { result } = renderHook(() => useAiGate('summary'));
    expect(result.current).toBe(false);
  });

  it('narrows by key: useAiGate(summary) ignores other capability flags', () => {
    // composerAssist:false, summary:true → useAiGate('summary') is true
    vi.mocked(useCapabilities).mockReturnValue({
      capabilities: {
        summary: true,
        fileFocus: false,
        hunkAnnotations: false,
        preSubmitValidators: false,
        composerAssist: false,
        draftSuggestions: false,
        draftReconciliation: false,
        inboxEnrichment: false,
        inboxRanking: false,
      },
      error: null,
      refetch: vi.fn(),
    });
    vi.mocked(usePreferences).mockReturnValue({
      preferences: {
        ui: { theme: 'system', accent: 'indigo', aiPreview: true, density: 'comfortable' },
        inbox: {} as never,
        github: {} as never,
      },
      error: null,
      refetch: vi.fn(),
      set: vi.fn(),
    } as never);

    expect(renderHook(() => useAiGate('summary')).result.current).toBe(true);
    expect(renderHook(() => useAiGate('composerAssist')).result.current).toBe(false);
  });
});
