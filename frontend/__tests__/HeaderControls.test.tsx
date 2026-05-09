import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HeaderControls } from '../src/components/Header/HeaderControls';

const setMock = vi.fn(() => Promise.resolve());
const refetchCapabilitiesMock = vi.fn(() => Promise.resolve());

vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { theme: 'system', accent: 'indigo', aiPreview: false },
    error: null,
    refetch: vi.fn(),
    set: setMock,
  }),
}));

vi.mock('../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({
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
    refetch: refetchCapabilitiesMock,
  }),
}));

beforeEach(() => {
  setMock.mockClear();
  refetchCapabilitiesMock.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('HeaderControls aiPreview toggle', () => {
  it('flips the aiPreview preference and refetches capabilities so consumers see the new flag immediately', async () => {
    render(<HeaderControls />);
    const toggle = await screen.findByRole('button', { name: /ai/i });
    await userEvent.click(toggle);
    await waitFor(() => expect(setMock).toHaveBeenCalledWith('aiPreview', true));
    // Capabilities must refetch right after the flip — without it the cached
    // state lags until the next window focus and the Overview hero region
    // briefly renders empty (cap=false but pref=true causes the AI card to
    // skip render while PrDescription drops the no-ai modifier).
    await waitFor(() => expect(refetchCapabilitiesMock).toHaveBeenCalledTimes(1));
  });
});
