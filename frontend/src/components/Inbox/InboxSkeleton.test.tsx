import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { InboxSkeleton } from './InboxSkeleton';

describe('InboxSkeleton', () => {
  it('renders the fixed number of section + row placeholders', () => {
    render(<InboxSkeleton showRail={false} />);
    expect(screen.getByTestId('inbox-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('inbox-skeleton-section').length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByTestId('inbox-skeleton-row').length).toBeGreaterThanOrEqual(4);
  });

  it('renders the rail only when showRail is true', () => {
    const { rerender } = render(<InboxSkeleton showRail={false} />);
    expect(screen.queryByTestId('inbox-skeleton-rail')).toBeNull();
    rerender(<InboxSkeleton showRail />);
    expect(screen.getByTestId('inbox-skeleton-rail')).toBeInTheDocument();
  });

  it('carries the AT loading signal and renders no buttons', () => {
    render(<InboxSkeleton showRail />);
    expect(screen.getByTestId('inbox-skeleton')).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});
