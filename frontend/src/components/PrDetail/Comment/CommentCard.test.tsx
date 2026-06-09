// CommentCard.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { CommentCard } from './CommentCard';

describe('CommentCard', () => {
  const base = {
    author: 'amelia.cho',
    avatarUrl: null,
    createdAt: '2026-05-18T00:00:00Z',
    body: 'Guard against `overflow`?',
  };

  it('renders band (author + time) and markdown body, forwarding testid + aria-label', () => {
    render(
      <CommentCard {...base} data-testid="pr-root-comment" aria-label="Comment by amelia.cho" />,
    );
    const card = screen.getByTestId('pr-root-comment');
    expect(card).toHaveAttribute('aria-label', 'Comment by amelia.cho');
    expect(screen.getByText('amelia.cho')).toBeInTheDocument();
    expect(screen.getByText('overflow')).toBeInTheDocument(); // inline code rendered
    expect(card.querySelector('time')).toHaveAttribute('dateTime', '2026-05-18T00:00:00Z');
  });

  it('defaults to comfortable density and honors compact', () => {
    const { rerender } = render(<CommentCard {...base} data-testid="c" />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-density', 'comfortable');
    rerender(<CommentCard {...base} density="compact" data-testid="c" />);
    expect(screen.getByTestId('c')).toHaveAttribute('data-density', 'compact');
  });

  it('renders the bandEnd slot (caller composition, e.g. a Resolved tag)', () => {
    render(<CommentCard {...base} data-testid="c" bandEnd={<span>Resolved</span>} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });
});
