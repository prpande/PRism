import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { ExistingCommentWidget } from '../src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget';
import type {
  ReviewThreadDto,
  ReviewCommentDto,
} from '../src/api/types';
import type { ExistingCommentWidgetReplyContext } from '../src/components/PrDetail/FilesTab/DiffPane/ExistingCommentWidget';
import type { OptimisticComment } from '../src/components/PrDetail/FilesTab/optimisticComment';

function comment(over: Partial<ReviewCommentDto> = {}): ReviewCommentDto {
  return {
    commentId: 'c1',
    author: 'amelia.cho',
    avatarUrl: null,
    body: 'existing body',
    createdAt: '2026-05-18T00:00:00Z',
    editedAt: null,
    ...over,
  };
}

function thread(over: Partial<ReviewThreadDto> = {}): ReviewThreadDto {
  return {
    threadId: 't1',
    filePath: 'src/Calc.cs',
    lineNumber: 5,
    anchorSha: 'sha1',
    isResolved: false,
    comments: [comment()],
    ...over,
  };
}

// A minimal reply context. The optimistic-card path does not require any of the
// composer machinery — only that `replyContext` is present (it gates the
// per-thread render branch) and carries `optimisticByThread`.
function replyContext(
  optimisticByThread: Record<string, OptimisticComment[]>,
): ExistingCommentWidgetReplyContext {
  return {
    prRef: { owner: 'o', repo: 'r', number: 1 },
    prState: 'open',
    draftReplies: [],
    registerOpenComposer: () => () => {},
    onReplyComposerClose: () => {},
    optimisticByThread,
  };
}

describe('ExistingCommentWidget — optimistic reply card', () => {
  it('renders an extra dimmed optimistic card for the thread', () => {
    const t = thread();
    const opt: OptimisticComment = {
      clientId: 'client-1',
      threadId: 't1',
      body: 'my optimistic reply',
      author: 'You',
      createdAt: '2026-05-18T12:00:00Z',
      postedCommentId: 4242,
    };
    render(
      <ExistingCommentWidget
        threads={[t]}
        replyContext={replyContext({ t1: [opt] })}
      />,
    );

    const optimisticCard = screen.getByTestId('inline-comment-card-optimistic');
    expect(optimisticCard).toBeInTheDocument();
    expect(optimisticCard).toHaveTextContent('my optimistic reply');
    // Dimmed via the posting class.
    expect(optimisticCard.className).toContain('comment-card--posting');
    // The real (non-optimistic) card is still there.
    expect(screen.getByTestId('inline-comment-card')).toHaveTextContent('existing body');
  });

  it('does NOT render the optimistic card once a real comment with the matching databaseId arrives (de-dup by databaseId)', () => {
    // The refetch landed: the thread now contains a real comment whose
    // databaseId equals the optimistic entry's postedCommentId.
    const t = thread({
      comments: [
        comment(),
        comment({
          commentId: 'c2',
          body: 'my optimistic reply',
          databaseId: 4242,
        }),
      ],
    });
    const opt: OptimisticComment = {
      clientId: 'client-1',
      threadId: 't1',
      body: 'my optimistic reply',
      author: 'You',
      createdAt: '2026-05-18T12:00:00Z',
      postedCommentId: 4242,
    };
    render(
      <ExistingCommentWidget
        threads={[t]}
        replyContext={replyContext({ t1: [opt] })}
      />,
    );

    expect(screen.queryByTestId('inline-comment-card-optimistic')).not.toBeInTheDocument();
    // The real comment (now with databaseId) is rendered as a normal card.
    const realCards = screen.getAllByTestId('inline-comment-card');
    expect(realCards.some((c) => c.textContent?.includes('my optimistic reply'))).toBe(true);
  });

  it('two optimistic placeholders with the same body but distinct postedCommentIds both render, then only the unmatched one remains after refetch', () => {
    const SHARED_BODY = 'shared body text';
    const opt4242: OptimisticComment = {
      clientId: 'client-a',
      threadId: 't1',
      body: SHARED_BODY,
      author: 'You',
      createdAt: '2026-05-18T12:00:00Z',
      postedCommentId: 4242,
    };
    const opt4243: OptimisticComment = {
      clientId: 'client-b',
      threadId: 't1',
      body: SHARED_BODY,
      author: 'You',
      createdAt: '2026-05-18T12:00:01Z',
      postedCommentId: 4243,
    };

    // Phase 1: both placeholders visible before refetch lands
    const { rerender } = render(
      <ExistingCommentWidget
        threads={[thread()]}
        replyContext={replyContext({ t1: [opt4242, opt4243] })}
      />,
    );

    const allOptimistic = screen.getAllByTestId('inline-comment-card-optimistic');
    expect(allOptimistic).toHaveLength(2);

    // Phase 2: refetch lands a real comment matching postedCommentId 4242
    const threadWithReal = thread({
      comments: [
        comment(),
        comment({ commentId: 'c-real', body: SHARED_BODY, databaseId: 4242 }),
      ],
    });

    rerender(
      <ExistingCommentWidget
        threads={[threadWithReal]}
        replyContext={replyContext({ t1: [opt4242, opt4243] })}
      />,
    );

    // Only the 4243 placeholder remains
    expect(screen.getAllByTestId('inline-comment-card-optimistic')).toHaveLength(1);
  });

  it('de-dups by databaseId, not by body text (a same-body real comment without the matching databaseId keeps the optimistic card)', () => {
    const t = thread({
      comments: [
        // Same body as the optimistic entry, but a DIFFERENT databaseId — this
        // is NOT the comment we just posted. The optimistic card must remain.
        comment({ body: 'my optimistic reply', databaseId: 9999 }),
      ],
    });
    const opt: OptimisticComment = {
      clientId: 'client-1',
      threadId: 't1',
      body: 'my optimistic reply',
      author: 'You',
      createdAt: '2026-05-18T12:00:00Z',
      postedCommentId: 4242,
    };
    render(
      <ExistingCommentWidget
        threads={[t]}
        replyContext={replyContext({ t1: [opt] })}
      />,
    );

    expect(screen.getByTestId('inline-comment-card-optimistic')).toBeInTheDocument();
  });
});
