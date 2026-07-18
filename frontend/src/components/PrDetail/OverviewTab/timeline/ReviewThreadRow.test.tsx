import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReviewThreadRow } from './ReviewThreadRow';
import type { ReviewThreadDto } from '../../../../api/types';

const base = (over: Partial<ReviewThreadDto>): ReviewThreadDto => ({
  threadId: 't1',
  filePath: 'src/Calc.cs',
  lineNumber: 5,
  isResolved: false,
  comments: [
    {
      commentId: 'c1',
      author: 'alice',
      avatarUrl: null,
      createdAt: '2026-01-01T00:00:00Z',
      body: 'First body',
      editedAt: null,
    },
  ],
  ...over,
});

describe('ReviewThreadRow', () => {
  it('anchored thread shows a path:line chip and the first-comment snippet, collapsed', () => {
    render(<ReviewThreadRow thread={base({})} />);
    expect(screen.getByText('src/Calc.cs:5')).toBeInTheDocument();
    expect(screen.getByText('First body')).toBeInTheDocument();
    // collapsed: the hunk/comment panel is not rendered
    expect(screen.getByRole('button', { name: /thread/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('outdated LINE thread shows an Outdated badge and no line chip', () => {
    render(
      <ReviewThreadRow
        thread={base({
          lineNumber: null,
          isOutdated: true,
          subjectType: 'LINE',
          originalLine: 12,
          originalStartLine: null,
        })}
      />,
    );
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.queryByText(/src\/Calc\.cs:/)).not.toBeInTheDocument();
  });

  it('file-level thread shows a File chip even when outdated', () => {
    render(
      <ReviewThreadRow
        thread={base({ lineNumber: null, isOutdated: true, subjectType: 'FILE' })}
      />,
    );
    expect(screen.getByText('File')).toBeInTheDocument();
    expect(screen.queryByText('Outdated')).not.toBeInTheDocument();
  });

  it('outdated thread with a non-null lineNumber still shows Outdated, not a line chip', () => {
    render(
      <ReviewThreadRow
        thread={base({ isOutdated: true, lineNumber: 671, subjectType: 'LINE', originalLine: 668 })}
      />,
    );
    expect(screen.getByText('Outdated')).toBeInTheDocument();
    expect(screen.queryByText('src/Calc.cs:671')).not.toBeInTheDocument();
  });

  it('shows a reply count only when there is more than one comment', () => {
    const two = base({
      comments: [
        {
          commentId: 'c1',
          author: 'alice',
          createdAt: '2026-01-01T00:00:00Z',
          body: 'a',
          editedAt: null,
        },
        {
          commentId: 'c2',
          author: 'bob',
          createdAt: '2026-01-02T00:00:00Z',
          body: 'b',
          editedAt: null,
        },
      ],
    });
    render(<ReviewThreadRow thread={two} />);
    expect(screen.getByText('1 reply')).toBeInTheDocument();
  });

  it('shows a Resolved chip for resolved threads', () => {
    render(<ReviewThreadRow thread={base({ isResolved: true })} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  // Spec testing bullet: a resolve done in the Files tab surfaces on the timeline row after the
  // PrDetail reload delivers the updated thread. At the component level that is an isResolved
  // prop flip (reload → new prop) — assert the chip reflects it.
  it('reflects a resolve arriving on reload (isResolved false→true)', () => {
    const { rerender } = render(<ReviewThreadRow thread={base({ isResolved: false })} />);
    expect(screen.queryByText('Resolved')).not.toBeInTheDocument();
    rerender(<ReviewThreadRow thread={base({ isResolved: true })} />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });

  it('expanding an anchored thread reveals the diffHunk block and the comment stack', async () => {
    const user = userEvent.setup();
    render(<ReviewThreadRow thread={base({ diffHunk: '@@ -1,2 +1,2 @@\n-old\n+new' })} />);
    await user.click(screen.getByRole('button', { name: /thread/i }));
    expect(screen.getByRole('button', { name: /thread/i })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByTestId('timeline-thread-hunk')).toHaveTextContent('+new');
  });

  it('expanding an outdated thread labels the snippet with the original range and omits the hunk when null', async () => {
    const user = userEvent.setup();
    render(
      <ReviewThreadRow
        thread={base({
          lineNumber: null,
          isOutdated: true,
          subjectType: 'LINE',
          originalStartLine: 592,
          originalLine: 596,
          diffHunk: null,
        })}
      />,
    );
    await user.click(screen.getByRole('button', { name: /thread/i }));
    expect(screen.getByText('was L592–596')).toBeInTheDocument();
    expect(screen.queryByTestId('timeline-thread-hunk')).not.toBeInTheDocument();
  });

  it('folds thread status into the row button accessible name (a11y)', () => {
    const { rerender } = render(
      <ReviewThreadRow
        thread={base({ isOutdated: true, lineNumber: null, subjectType: 'LINE', originalLine: 3 })}
      />,
    );
    // outdated status reaches the accessible name, not just the visual badge
    expect(
      screen.getByRole('button', { name: /review thread on src\/Calc\.cs, outdated/i }),
    ).toBeInTheDocument();
    rerender(
      <ReviewThreadRow
        thread={base({ lineNumber: 5, isOutdated: false, subjectType: 'LINE', isResolved: true })}
      />,
    );
    expect(
      screen.getByRole('button', { name: /review thread on src\/Calc\.cs, line 5, resolved/i }),
    ).toBeInTheDocument();
  });

  it('renders a View in diff button for anchored threads and invokes onViewInDiff', async () => {
    const user = userEvent.setup();
    const onViewInDiff = vi.fn();
    render(<ReviewThreadRow thread={base({})} onViewInDiff={onViewInDiff} />);
    await user.click(screen.getByRole('button', { name: /view in diff/i }));
    expect(onViewInDiff).toHaveBeenCalledWith('src/Calc.cs', 't1');
  });

  it('does not render View in diff for outdated or file-level threads', () => {
    const onViewInDiff = vi.fn();
    const { rerender } = render(
      <ReviewThreadRow
        thread={base({ lineNumber: null, isOutdated: true, subjectType: 'LINE' })}
        onViewInDiff={onViewInDiff}
      />,
    );
    expect(screen.queryByRole('button', { name: /view in diff/i })).not.toBeInTheDocument();
    rerender(
      <ReviewThreadRow
        thread={base({ lineNumber: null, subjectType: 'FILE' })}
        onViewInDiff={onViewInDiff}
      />,
    );
    expect(screen.queryByRole('button', { name: /view in diff/i })).not.toBeInTheDocument();
  });
});
