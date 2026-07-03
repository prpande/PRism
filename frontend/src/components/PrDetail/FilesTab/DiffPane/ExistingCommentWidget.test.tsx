import { render, screen, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import { ReplyDataProvider } from '../ReplyDataContext';
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
      <ReplyDataProvider
        value={{
          draftComments: [],
          draftReplies: [],
          postingInProgress: false,
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
      >
        <ExistingCommentWidget
          threads={[thread()]}
          replyContext={{
            prRef: { owner: 'o', repo: 'r', number: 1 },
            prState: 'open',
            registerOpenComposer: () => () => {},
            onReplyComposerClose: () => {},
          }}
        />
      </ReplyDataProvider>,
    );
    const optimistic = screen.getByTestId('inline-comment-card-optimistic');
    expect(optimistic).toHaveAttribute('data-density', 'comfortable');
  });

  it('shows a Resolved tag on resolved threads (in the collapsed summary)', () => {
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: true })]}
        collapse={collapseStub(true)}
      />,
    );
    const header = screen.getByTestId('thread-disclosure');
    expect(within(header).getByLabelText('Resolved thread')).toBeInTheDocument();
  });
});

function collapseStub(collapsed: boolean, toggle = () => {}) {
  return { isCollapsed: () => collapsed, toggle };
}

describe('ExistingCommentWidget — collapse', () => {
  it('collapsed: renders the disclosure summary, not the cards or reply affordance', () => {
    render(
      <ExistingCommentWidget
        threads={[thread({ isResolved: true })]}
        collapse={collapseStub(true)}
      />,
    );
    expect(screen.getByTestId('thread-disclosure')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('inline-comment-card')).not.toBeInTheDocument();
  });

  it('expanded: renders the cards and an aria-expanded=true header', () => {
    render(<ExistingCommentWidget threads={[thread()]} collapse={collapseStub(false)} />);
    expect(screen.getByTestId('thread-disclosure')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getAllByTestId('inline-comment-card').length).toBeGreaterThan(0);
  });

  it('no collapse prop: threads render fully expanded (back-compat)', () => {
    render(<ExistingCommentWidget threads={[thread()]} />);
    expect(screen.getAllByTestId('inline-comment-card').length).toBeGreaterThan(0);
  });

  it('toggling the disclosure calls collapse.toggle(threadId, isResolved)', async () => {
    const toggle = vi.fn();
    const user = userEvent.setup();
    render(
      <ExistingCommentWidget
        threads={[thread({ threadId: 't1', isResolved: true })]}
        collapse={collapseStub(true, toggle)}
      />,
    );
    await user.click(screen.getByTestId('thread-disclosure'));
    expect(toggle).toHaveBeenCalledWith('t1', true);
  });

  it('collapsed snippet derives from the first comment body, stripped', () => {
    const t = thread({ isResolved: true });
    t.comments[0].body = '## Heading\nfirst line of prose';
    render(<ExistingCommentWidget threads={[t]} collapse={collapseStub(true)} />);
    expect(screen.getByTestId('thread-snippet')).toHaveTextContent('Heading');
  });
});
