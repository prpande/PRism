import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiSummaryCard } from './AiSummaryCard';

// SampleBadge (rendered in content branch) calls useIsSampleMode() → usePreferences().
// The card's responsibility is only that it mounts the badge slot; badge gating is
// covered by SampleBadge's own tests. Stub it so the content tests are deterministic.
vi.mock('../../Ai/SampleBadge', () => ({
  SampleBadge: () => <span data-testid="sample-badge-stub" />,
}));

describe('AiSummaryCard', () => {
  it('renders nothing when absent (no summary, not loading, no error)', () => {
    const { container } = render(<AiSummaryCard summary={null} loading={false} error={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows loading status', () => {
    render(<AiSummaryCard summary={null} loading error={false} />);
    expect(screen.getByText('Loading AI summary…')).toBeInTheDocument();
  });

  it('shows the recovery-naming error copy', () => {
    render(<AiSummaryCard summary={null} loading={false} error />);
    expect(screen.getByText(/reopen this PR to try again/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });

  it('renders a category chip for a confident category', () => {
    render(
      <AiSummaryCard summary={{ body: 'b', category: 'fix' }} loading={false} error={false} />,
    );
    expect(screen.getByText('Fix')).toBeInTheDocument();
  });

  it('renders no category row when category is empty', () => {
    render(<AiSummaryCard summary={{ body: 'b', category: '' }} loading={false} error={false} />);
    expect(screen.queryByTestId('ai-summary-category')).not.toBeInTheDocument();
  });

  it('mounts the SampleBadge slot in the content branch', () => {
    render(
      <AiSummaryCard summary={{ body: 'b', category: 'fix' }} loading={false} error={false} />,
    );
    expect(screen.getByTestId('sample-badge-stub')).toBeInTheDocument();
  });
});
