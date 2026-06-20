import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import type { ReviewThreadDto } from '../../../../api/types';

function thread(over: Partial<ReviewThreadDto> = {}): ReviewThreadDto {
  return {
    threadId: 't1',
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    isResolved: false,
    comments: [
      {
        commentId: 'c1',
        author: 'amelia.cho',
        avatarUrl: null,
        body: 'one',
        createdAt: '2026-05-18T00:00:00Z',
      },
      {
        commentId: 'c2',
        author: 'prpande',
        avatarUrl: null,
        body: 'two',
        createdAt: '2026-05-18T00:00:00Z',
      },
    ],
    ...over,
  } as ReviewThreadDto; // cast satisfies the omitted editedAt/anchorSha fields — keep it.
}

describe('ExistingCommentWidget', () => {
  it('renders one CommentCard per comment (clear demarcation)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    const cards = screen.getAllByTestId('inline-comment-card');
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText('amelia.cho')).toBeInTheDocument();
    expect(within(cards[1]).getByText('prpande')).toBeInTheDocument();
  });

  it('renders inline comment cards at comfortable density (Overview parity)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    const cards = screen.getAllByTestId('inline-comment-card');
    expect(cards).toHaveLength(2);
    for (const card of cards) {
      expect(card).toHaveAttribute('data-density', 'comfortable');
    }
  });

  it('renders the optimistic comment card at comfortable density', () => {
    render(
      <ExistingCommentWidget
        threads={[thread()]}
        replyContext={{
          prRef: { owner: 'o', repo: 'r', number: 1 },
          prState: 'open',
          draftReplies: [],
          registerOpenComposer: () => () => {},
          onReplyComposerClose: () => {},
          optimisticByThread: {
            t1: [
              {
                clientId: 'opt1',
                threadId: 't1',
                body: 'optimistic',
                author: 'amelia.cho',
                createdAt: '2026-05-18T00:00:00Z',
                postedCommentId: 999,
              },
            ],
          },
        }}
      />,
    );
    const optimistic = screen.getByTestId('inline-comment-card-optimistic');
    expect(optimistic).toHaveAttribute('data-density', 'comfortable');
  });

  it('shows a Resolved tag on resolved threads', () => {
    render(<ExistingCommentWidget threads={[thread({ isResolved: true })]} />);
    expect(screen.getByLabelText('Resolved thread')).toBeInTheDocument();
  });
});
