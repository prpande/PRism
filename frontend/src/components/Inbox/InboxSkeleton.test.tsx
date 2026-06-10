import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboxSkeleton } from './InboxSkeleton';

describe('InboxSkeleton', () => {
  it('renders the fixed number of section + row placeholders', () => {
    render(<InboxSkeleton showRail={false} />);
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
    // 3 sections × 3 rows — exact so a dropped section/row regresses loudly.
    expect(screen.getAllByTestId('inbox-skeleton-section')).toHaveLength(3);
    expect(screen.getAllByTestId('inbox-skeleton-row')).toHaveLength(9);
  });

  it('renders the rail (Activity + Watching panels) only when showRail is true', () => {
    const { rerender } = render(<InboxSkeleton showRail={false} />);
    expect(screen.queryByTestId('inbox-skeleton-rail')).toBeNull();
    rerender(<InboxSkeleton showRail />);
    const rail = screen.getByTestId('inbox-skeleton-rail');
    // P2: two skeleton blocks — Activity (taller) + Watching (shorter).
    // Skeleton does not forward data-testid unless explicitly passed — count direct children.
    expect(rail.children).toHaveLength(2);
  });

  it('carries the AT loading signal and renders no buttons', () => {
    render(<InboxSkeleton showRail />);
    expect(screen.getByTestId('inbox-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
