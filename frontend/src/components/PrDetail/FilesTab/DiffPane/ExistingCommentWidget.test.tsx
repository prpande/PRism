import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ExistingCommentWidget } from './ExistingCommentWidget';
import type { ReviewThreadDto } from '../../../../api/types';

const thread: ReviewThreadDto = {
  threadId: 'PRRT_1',
  filePath: 'src/Widget.cs',
  lineNumber: 42,
  anchorSha: 'sha',
  isResolved: false,
  comments: [
    {
      commentId: 'PRC_1',
      author: 'bob',
      createdAt: '2026-01-02T00:01:00Z',
      body: 'nit',
      editedAt: null,
      avatarUrl: 'https://avatars.githubusercontent.com/u/2?v=4',
    },
  ],
};

describe('ExistingCommentWidget', () => {
  it('renders an avatar next to the review-comment author', () => {
    render(<ExistingCommentWidget threads={[thread]} />);
    const author = screen.getByText('bob');
    const meta = author.closest('.comment-meta');
    expect(meta?.querySelector('[data-testid="avatar"]')).not.toBeNull();
  });
});
