import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
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

  it('renders the muted Preview chip with the spec copy when summary is supplied', () => {
    render(<AiSummaryCard summary={{ body: 'b', category: 'c' }} />);
    const chip = screen.getByText(/AI preview — sample content, not generated from this PR/);
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveClass('muted');
  });

  it('applies the overview-card-hero + ai-tint hero classes when summary is supplied', () => {
    const { container } = render(<AiSummaryCard summary={{ body: 'b', category: 'c' }} />);
    const card = container.querySelector('.ai-summary-card');
    expect(card).toHaveClass('overview-card');
    expect(card).toHaveClass('overview-card-hero');
    expect(card).toHaveClass('ai-tint');
  });
});
