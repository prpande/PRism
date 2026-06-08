import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// SampleBadge (rendered inside AiSummaryCard) reads aiMode via usePreferences /
// useIsSampleMode. Drive aiMode:'preview' so the badge mounts; the card itself
// gates only on `summary` (not on preferences).
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: 'preview' } } }),
}));

import { AiSummaryCard } from '../src/components/PrDetail/OverviewTab/AiSummaryCard';

describe('AiSummaryCard', () => {
  it('renders nothing when summary is null (gating off)', () => {
    const { container } = render(<AiSummaryCard summary={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the body and category when summary is supplied', () => {
    render(
      <AiSummaryCard
        summary={{ body: 'Refactors LeaseRenewalProcessor.', category: 'Refactor' }}
      />,
    );
    expect(screen.getByText(/Refactors LeaseRenewalProcessor\./)).toBeInTheDocument();
    expect(screen.getByText('Refactor')).toBeInTheDocument();
  });

  it('renders the SampleBadge (replacing the old hardcoded Preview chip) when summary is supplied', () => {
    // Task 6 replaced the hardcoded "AI preview — sample content…" chip with
    // <SampleBadge/>, which renders the data-testid="sample-badge" pill in preview mode.
    render(<AiSummaryCard summary={{ body: 'b', category: 'c' }} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(
      screen.queryByText(/AI preview — sample content, not generated from this PR/),
    ).toBeNull();
  });

  it('applies the overview-card-hero + ai-tint hero classes when summary is supplied', () => {
    const { container } = render(<AiSummaryCard summary={{ body: 'b', category: 'c' }} />);
    const card = within(container).getByTestId('ai-summary-card');
    expect(card).toHaveClass('overview-card');
    expect(card).toHaveClass('overview-card-hero');
    expect(card).toHaveClass('ai-tint');
  });
});
