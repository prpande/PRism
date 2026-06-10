import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// SampleBadge (rendered inside AiSummaryCard) reads aiMode via usePreferences /
// useIsSampleMode. Stub so content-branch tests are deterministic and isolated
// from preferences context. Badge gating is covered by SampleBadge's own tests.
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: 'preview' } } }),
}));

import { AiSummaryCard } from '../src/components/PrDetail/OverviewTab/AiSummaryCard';

describe('AiSummaryCard', () => {
  it('renders nothing when summary is null (gating off)', () => {
    const { container } = render(<AiSummaryCard summary={null} loading={false} error={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the body and a mapped category chip when summary is supplied', () => {
    render(
      <AiSummaryCard
        summary={{ body: 'Refactors LeaseRenewalProcessor.', category: 'refactor' }}
        loading={false}
        error={false}
      />,
    );
    expect(screen.getByText(/Refactors LeaseRenewalProcessor\./)).toBeInTheDocument();
    // category 'refactor' maps to label 'Refactor'
    expect(screen.getByTestId('ai-summary-category')).toHaveTextContent('Refactor');
  });

  it('renders the SampleBadge (replacing the old hardcoded Preview chip) when summary is supplied', () => {
    // Task 6 replaced the hardcoded "AI preview — sample content…" chip with
    // <SampleBadge/>, which renders the data-testid="sample-badge" pill in preview mode.
    render(<AiSummaryCard summary={{ body: 'b', category: 'c' }} loading={false} error={false} />);
    expect(screen.getByTestId('sample-badge')).toBeInTheDocument();
    expect(
      screen.queryByText(/AI preview — sample content, not generated from this PR/),
    ).toBeNull();
  });

  it('applies the overview-card-hero + ai-tint hero classes when summary is supplied', () => {
    const { container } = render(
      <AiSummaryCard summary={{ body: 'b', category: 'c' }} loading={false} error={false} />,
    );
    const card = within(container).getByTestId('ai-summary-card');
    expect(card).toHaveClass('overview-card');
    expect(card).toHaveClass('overview-card-hero');
    expect(card).toHaveClass('ai-tint');
  });
});
