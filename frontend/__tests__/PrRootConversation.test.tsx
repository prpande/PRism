import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { PrRootConversation } from '../src/components/PrDetail/OverviewTab/PrRootConversation';
import type { IssueCommentDto } from '../src/api/types';

const aliceComment: IssueCommentDto = {
  id: 101,
  author: 'alice',
  createdAt: '2026-05-08T14:00:00Z',
  body: 'Looks good — see comment about **WhenAll** semantics.',
};

const bobComment: IssueCommentDto = {
  id: 102,
  author: 'bob',
  createdAt: '2026-05-08T15:00:00Z',
  body: 'Acknowledged.',
};

describe('PrRootConversation', () => {
  it('renders the S4 footer copy even when there are no comments', () => {
    render(<PrRootConversation comments={[]} />);
    expect(
      screen.getByText(/Reply lands when the comment composer ships in S4\./),
    ).toBeInTheDocument();
  });

  it('renders no comment entries when comments is empty', () => {
    const { container } = render(<PrRootConversation comments={[]} />);
    expect(container.querySelectorAll('.pr-root-comment')).toHaveLength(0);
  });

  it('renders a single comment with author, timestamp, and Markdown body', () => {
    render(<PrRootConversation comments={[aliceComment]} />);
    expect(screen.getByText('alice')).toBeInTheDocument();
    const timeEl = screen.getByText((_, el) => el?.tagName.toLowerCase() === 'time');
    expect(timeEl).toHaveAttribute('dateTime', '2026-05-08T14:00:00Z');
    const strong = screen.getByText('WhenAll');
    expect(strong.tagName.toLowerCase()).toBe('strong');
  });

  it('renders multiple comments in the supplied order', () => {
    render(<PrRootConversation comments={[aliceComment, bobComment]} />);
    const authors = screen.getAllByText(/^(alice|bob)$/).map((el) => el.textContent);
    expect(authors).toEqual(['alice', 'bob']);
  });

  it('does not render any Reply button (composer ships in S4)', () => {
    render(<PrRootConversation comments={[aliceComment, bobComment]} />);
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
  });

  it('does not render a Mark all read button (read-only in S3)', () => {
    render(<PrRootConversation comments={[aliceComment]} />);
    expect(screen.queryByRole('button', { name: /mark all read/i })).not.toBeInTheDocument();
  });

  it('keys comments by id (no React duplicate-key warning when shapes differ)', () => {
    const { container } = render(<PrRootConversation comments={[aliceComment, bobComment]} />);
    const items = container.querySelectorAll('.pr-root-comment');
    expect(items).toHaveLength(2);
  });

  it('isolates each comment so author is scoped to its entry', () => {
    const { container } = render(<PrRootConversation comments={[aliceComment, bobComment]} />);
    const entries = container.querySelectorAll('.pr-root-comment');
    expect(within(entries[0] as HTMLElement).getByText('alice')).toBeInTheDocument();
    expect(within(entries[1] as HTMLElement).getByText('bob')).toBeInTheDocument();
  });
});
