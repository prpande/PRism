import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PrRootConversation } from './PrRootConversation';
import type { IssueCommentDto } from '../../../api/types';

const comments: IssueCommentDto[] = [
  {
    id: 1,
    author: 'alice',
    createdAt: '2026-01-02T00:00:00Z',
    body: 'looks good',
    avatarUrl: 'https://avatars.githubusercontent.com/u/1?v=4',
  },
];

describe('PrRootConversation', () => {
  it('renders an avatar in the comment band next to the author', () => {
    render(<PrRootConversation comments={comments} replyContext={undefined} />);
    const card = screen.getByTestId('pr-root-comment');
    expect(card.querySelector('[data-testid="avatar"]')).not.toBeNull();
    expect(card.textContent).toContain('alice');
  });
});
