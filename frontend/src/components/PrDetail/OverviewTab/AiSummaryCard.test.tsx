import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { AiSummaryCard } from './AiSummaryCard';

// SampleBadge (rendered in content branch) calls useIsSampleMode() → usePreferences().
// The card's responsibility is only that it mounts the badge slot; badge gating is
// covered by SampleBadge's own tests. Stub it so the content tests are deterministic.
vi.mock('../../Ai/SampleBadge', () => ({
  SampleBadge: () => <span data-testid="sample-badge-stub" />,
}));

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

  it('maps a capitalized category (Preview placeholder) case-insensitively', () => {
    render(
      <AiSummaryCard summary={{ body: 'b', category: 'Refactor' }} loading={false} error={false} />,
    );
    expect(screen.getByText('Refactor')).toBeInTheDocument();
  });

  it('renders no chip for an out-of-taxonomy category', () => {
    render(
      <AiSummaryCard summary={{ body: 'b', category: 'cat' }} loading={false} error={false} />,
    );
    expect(screen.queryByTestId('ai-summary-category')).not.toBeInTheDocument();
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

  it('Live + stale: shows the Out of date chip + Regenerate over the present body', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'present body', category: 'fix' }}
        isStale
        live
      />,
    );
    expect(screen.getByText('present body')).toBeInTheDocument(); // body retained
    expect(screen.getByText(/out of date/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /regenerate summary/i })).toBeInTheDocument();
  });

  it('Live + stale chip lives in a status region (announced)', () => {
    render(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} isStale live />);
    const region = screen.getByRole('status');
    expect(within(region).getByText(/out of date/i)).toBeInTheDocument();
  });

  it('announces on mount when already stale (returning from Settings after a cap change)', () => {
    // The chip is present at first render, so the polite live region would otherwise stay silent.
    render(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} isStale live />);
    const region = screen.getByRole('status');
    expect(within(region).getByText('Summary is no longer up to date.')).toBeInTheDocument();
  });

  it('does NOT announce stale-on-mount in Preview (the chip is Live-only)', () => {
    render(
      <AiSummaryCard
        {...baseProps}
        summary={{ body: 'b', category: 'fix' }}
        isStale
        live={false}
      />,
    );
    expect(screen.queryByText('Summary is no longer up to date.')).not.toBeInTheDocument();
  });

  it('does NOT announce stale-on-mount when fresh', () => {
    render(<AiSummaryCard {...baseProps} summary={{ body: 'b', category: 'fix' }} live />);
    expect(screen.queryByText('Summary is no longer up to date.')).not.toBeInTheDocument();
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

  it('renders a bulleted body as a real list (markdown)', () => {
    render(
      <AiSummaryCard
        summary={{ body: '- first point\n- second point', category: 'fix' }}
        loading={false}
        error={false}
      />,
    );
    const items = screen.getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('first point');
  });

  it('applies the shared .ai-markdown treatment to the body', () => {
    render(
      <AiSummaryCard
        summary={{ body: 'plain body', category: 'fix' }}
        loading={false}
        error={false}
      />,
    );
    expect(document.querySelector('.markdown-body.ai-markdown')).not.toBeNull();
  });

  it('does not render a raw <script> body as a live element (XSS)', () => {
    render(
      <AiSummaryCard
        summary={{ body: '<script>alert(1)</script>', category: 'fix' }}
        loading={false}
        error={false}
      />,
    );
    // react-markdown (no rehype-raw) DROPS raw HTML — there is neither a live
    // <script> element nor visible escaped text. Assert no live element only,
    // matching the repo's MarkdownRenderer security-test idiom.
    expect(document.querySelector('script')).toBeNull();
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

  it('does NOT render the label/marker on loading or error', () => {
    const { rerender } = render(<AiSummaryCard summary={null} loading error={false} />);
    expect(screen.queryByTestId('ai-marker')).toBeNull();
    rerender(<AiSummaryCard summary={null} loading={false} error />);
    expect(screen.queryByTestId('ai-marker')).toBeNull();
  });
});
