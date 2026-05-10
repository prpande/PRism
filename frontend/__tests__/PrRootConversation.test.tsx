import { render, screen, within } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  PrRootConversation,
  type PrRootConversationReplyContext,
} from '../src/components/PrDetail/OverviewTab/PrRootConversation';
import type { IssueCommentDto, PrReference } from '../src/api/types';

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

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const replyContext: PrRootConversationReplyContext = {
  prRef: ref,
  prState: 'open',
  existingPrRootDraft: null,
  registerOpenComposer: () => () => undefined,
  onComposerClose: () => undefined,
};

describe('PrRootConversation', () => {
  it('renders the read-only fallback footer when replyContext is omitted', () => {
    render(<PrRootConversation comments={[]} />);
    expect(screen.getByText(/Composer not available in this context\./)).toBeInTheDocument();
  });

  it('replaces the read-only footer with Reply + Mark-all-read actions when replyContext is supplied', () => {
    render(<PrRootConversation comments={[]} replyContext={replyContext} />);
    expect(screen.queryByText(/Composer not available in this context\./)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /mark all read/i })).toBeInTheDocument();
  });

  it('clicking Reply mounts the PrRootReplyComposer (form role with PR-root aria-label)', async () => {
    const user = await import('@testing-library/user-event').then((m) => m.default.setup());
    render(<PrRootConversation comments={[]} replyContext={replyContext} />);
    await user.click(screen.getByRole('button', { name: 'Reply' }));
    expect(screen.getByRole('form', { name: 'Reply to this PR' })).toBeInTheDocument();
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

  it('does not render any Reply button when replyContext is omitted', () => {
    render(<PrRootConversation comments={[aliceComment, bobComment]} />);
    expect(screen.queryByRole('button', { name: /reply/i })).not.toBeInTheDocument();
  });

  it('does not render a Mark all read button when replyContext is omitted', () => {
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
