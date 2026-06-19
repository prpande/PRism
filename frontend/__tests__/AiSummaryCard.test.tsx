import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';

// SampleBadge (rendered inside AiSummaryCard) reads aiMode via usePreferences /
// useIsSampleMode. Stub so content-branch tests are deterministic and isolated
// from preferences context. Badge gating is covered by SampleBadge's own tests.
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: { ui: { aiMode: 'preview' } } }),
}));

import { AiSummaryCard } from '../src/components/PrDetail/OverviewTab/AiSummaryCard';

const baseProps = {
  loading: false,
  error: false,
  isStale: false,
  regenerating: false,
  regenerateError: false,
  onRegenerate: vi.fn(),
  live: true,
};

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

  it('Live + stale: shows the Out of date chip + Regenerate over the present body', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'present body', category: 'fix' }}
        isStale
        live
      />,
    );
    expect(screen.getByText('present body')).toBeInTheDocument();
    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate summary/i })).toBeInTheDocument();
  });

  it('Live + stale chip lives in a status region (announced)', () => {
    render(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} isStale live />);
    const region = screen.getByRole('status');
    expect(within(region).getByText(/out of date/i)).toBeInTheDocument();
  });

  it('regenerating: control disabled + spinner, stale body + chip retained', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        isStale
        regenerating
        live
      />,
    );
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate summary/i })).toBeDisabled();
  });

  it('regenerate 503: stale body + chip retained, control re-enabled, transient error announced', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        isStale
        regenerateError
        live
      />,
    );
    expect(screen.getByText('b')).toBeInTheDocument();
    expect(screen.getByText(/couldn.t regenerate/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate summary/i })).toBeEnabled();
  });

  it('Live + fresh: no stale chip, no Regenerate', () => {
    render(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} live />);
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate summary/i })).not.toBeInTheDocument();
  });

  it('Preview (not live): never shows stale chip or Regenerate even if isStale', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        isStale
        live={false}
      />,
    );
    expect(screen.queryByText(/out of date/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /regenerate summary/i })).not.toBeInTheDocument();
    // The whole Live-only status region must be absent in Preview (it would otherwise steal the
    // SampleBadge adjacency margin and present an empty live region to AT).
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('announces "Summary updated" in the status region after a successful regenerate', () => {
    const { rerender } = render(
      <AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} regenerating live />,
    );
    // regenerating true → false with no error = success transition
    rerender(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} live />);
    const region = screen.getByRole('status');
    expect(within(region).getByText('Summary updated')).toBeInTheDocument();
  });

  it('does NOT announce "Summary updated" when regenerate ends in error', () => {
    const { rerender } = render(
      <AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} regenerating live />,
    );
    // regenerating true → false WITH error must NOT trigger the success announce
    rerender(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        regenerateError
        live
      />,
    );
    expect(screen.queryByText('Summary updated')).not.toBeInTheDocument();
  });

  it('clicking Regenerate calls onRegenerate', () => {
    const onRegenerate = vi.fn();
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        isStale
        live
        onRegenerate={onRegenerate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /regenerate summary/i }));
    expect(onRegenerate).toHaveBeenCalledTimes(1);
  });

  it('renders an "AI Summary" label with the decorative marker on success', () => {
    render(
      <AiSummaryCard summary={{ body: 'x', category: 'fix' }} loading={false} error={false} />,
    );
    expect(screen.getByText('AI Summary')).toBeInTheDocument();
    expect(screen.getByTestId('ai-marker')).toBeInTheDocument();
  });

  it('shows a working AI marker while loading', () => {
    render(<AiSummaryCard summary={null} loading error={false} />);
    const marker = screen.getByTestId('ai-marker');
    expect(marker.getAttribute('data-ai-state')).toBe('working');
  });

  it('does NOT render the label/marker on error', () => {
    render(<AiSummaryCard summary={null} loading={false} error />);
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });
});
