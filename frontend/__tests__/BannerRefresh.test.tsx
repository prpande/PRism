import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { BannerRefresh } from '../src/components/PrDetail/BannerRefresh';

describe('BannerRefresh', () => {
  it('renders nothing when hasUpdate is false', () => {
    const { container } = render(
      <BannerRefresh
        hasUpdate={false}
        headShaChanged={false}
        commentCountDelta={0}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when hasUpdate=true but neither headSha nor comments moved', () => {
    const { container } = render(
      <BannerRefresh
        hasUpdate
        headShaChanged={false}
        commentCountDelta={0}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('renders head-only copy', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={0}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Iteration 4 available/i)).toBeInTheDocument();
    expect(screen.getByText(/Reload to view/i)).toBeInTheDocument();
  });

  it('renders comments-only copy (plural)', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged={false}
        commentCountDelta={3}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/3 new comments — Reload to view/i)).toBeInTheDocument();
  });

  it('renders comments-only copy (singular)', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged={false}
        commentCountDelta={1}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/^1 new comment — Reload to view$/i)).toBeInTheDocument();
  });

  it('renders mixed copy with plural comments', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={2}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Iteration 4 \+ 2 new comments — Reload to view/i)).toBeInTheDocument();
  });

  it('renders mixed copy with singular comment', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={1}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    expect(screen.getByText(/Iteration 4 \+ 1 new comment — Reload to view/i)).toBeInTheDocument();
  });

  it('Reload button click fires onReload', async () => {
    const onReload = vi.fn();
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={0}
        currentIterationNumber={3}
        onReload={onReload}
        onDismiss={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /reload/i }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('Close button click fires onDismiss', async () => {
    const onDismiss = vi.fn();
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={2}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /dismiss|close/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('has role=status and aria-live=polite for screen readers', () => {
    render(
      <BannerRefresh
        hasUpdate
        headShaChanged
        commentCountDelta={0}
        currentIterationNumber={3}
        onReload={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByRole('status');
    expect(banner).toHaveAttribute('aria-live', 'polite');
  });
});
