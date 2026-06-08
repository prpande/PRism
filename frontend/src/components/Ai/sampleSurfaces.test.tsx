import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mock = vi.hoisted(() => ({
  aiMode: 'preview' as 'off' | 'preview' | 'live',
  composerOn: true,
}));
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: mock.aiMode } } }),
}));
vi.mock('../../hooks/useAiGate', async (orig) => {
  const actual = await orig<typeof import('../../hooks/useAiGate')>();
  return { ...actual, useAiGate: () => mock.composerOn };
});

import { AiSummaryCard } from '../PrDetail/OverviewTab/AiSummaryCard';
import { AiComposerAssistant } from './AiComposerAssistant';
import { PreSubmitValidatorCard } from '../PrDetail/SubmitDialog/PreSubmitValidatorCard';
import type { ValidatorResult } from '../../api/types';

beforeEach(() => {
  mock.aiMode = 'preview';
  mock.composerOn = true;
});

describe('card sample surfaces carry SampleBadge (not the old hardcoded string)', () => {
  it('AiSummaryCard shows the badge and no legacy string', () => {
    // Non-null summary is required: AiSummaryCard early-returns null when summary
    // is falsy (the badge lives in the non-null branch). PrSummary = { body, category }.
    render(<AiSummaryCard summary={{ body: 'Sample summary', category: 'Refactor' }} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(screen.queryByText(/AI preview — sample content/i)).toBeNull();
  });
  it('AiComposerAssistant shows the badge and keeps the descriptive remainder', () => {
    render(<AiComposerAssistant />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(screen.getByText(/composer suggestions appear here/i)).toBeInTheDocument();
    expect(screen.queryByText(/AI preview — composer/i)).toBeNull();
  });
  it('PreSubmitValidatorCard shows the badge and no legacy string', () => {
    const results: ValidatorResult[] = [{ severity: 'Suggestion', message: 'Sample check' }];
    render(<PreSubmitValidatorCard results={results} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(screen.queryByText(/AI preview — sample content/i)).toBeNull();
  });
});
