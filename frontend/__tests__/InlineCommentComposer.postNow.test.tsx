import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import {
  InlineCommentComposer,
  type InlineAnchor,
} from '../src/components/PrDetail/Composer/InlineCommentComposer';
import * as draftApi from '../src/api/draft';
import * as commentApi from '../src/api/comment';
import type { PrReference } from '../src/api/types';

vi.mock('../src/api/comment');

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const sampleAnchor: InlineAnchor = {
  filePath: 'src/Foo.cs',
  lineNumber: 42,
  side: 'right',
  anchoredSha: 'a'.repeat(40),
  anchoredLineContent: '    return 0;',
};

// Enough text to pass the COMPOSER_CREATE_THRESHOLD (3 chars) gate and be non-empty
const VALID_BODY = 'hello world';

function Harness({
  initialBody = VALID_BODY,
  initialDraftId = 'draft-uuid-1',
  prState = 'open' as 'open' | 'closed' | 'merged',
  anyOtherDraftsStaged = false,
  beginPosting = vi.fn(),
  endPosting = vi.fn(),
  onPosted = vi.fn(),
  onClose = vi.fn(),
}: {
  initialBody?: string;
  initialDraftId?: string | null;
  prState?: 'open' | 'closed' | 'merged';
  anyOtherDraftsStaged?: boolean;
  beginPosting?: () => void;
  endPosting?: () => void;
  onPosted?: (id: number, body: string) => void;
  onClose?: () => void;
}) {
  const [draftId, setDraftId] = useState<string | null>(initialDraftId);
  return (
    <InlineCommentComposer
      prRef={ref}
      prState={prState}
      anchor={sampleAnchor}
      initialBody={initialBody}
      draftId={draftId}
      onDraftIdChange={setDraftId}
      registerOpenComposer={() => () => undefined}
      onClose={onClose}
      anyOtherDraftsStaged={anyOtherDraftsStaged}
      beginPosting={beginPosting}
      endPosting={endPosting}
      onPosted={onPosted}
    />
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function settle(ms = 250) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('InlineCommentComposer — post-now (Task 9)', () => {
  // Case 1: open PR, no staged drafts → both buttons render
  it('open PR with anyOtherDraftsStaged=false renders both "Add to review" and "Comment" buttons', () => {
    render(<Harness prState="open" anyOtherDraftsStaged={false} />);
    expect(screen.getByRole('button', { name: 'Add to review' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();
  });

  // Case 2: anyOtherDraftsStaged=true → "Comment" aria-disabled, label is "Add review comment"
  it('anyOtherDraftsStaged=true: Comment is aria-disabled and "Add to review" becomes "Add review comment"', async () => {
    const onPosted = vi.fn();
    vi.mocked(commentApi.postComment).mockResolvedValue({ ok: true, postedCommentId: 1 });

    render(<Harness prState="open" anyOtherDraftsStaged={true} onPosted={onPosted} />);

    // Label changes to "Add review comment"
    expect(screen.getByRole('button', { name: 'Add review comment' })).toBeInTheDocument();

    // "Comment" button uses aria-disabled (not native disabled) so the tooltip is hoverable
    const commentBtn = screen.getByRole('button', { name: 'Comment' });
    expect(commentBtn).toHaveAttribute('aria-disabled', 'true');
    // Native disabled must NOT be set (it would suppress the tooltip)
    expect(commentBtn).not.toBeDisabled();

    // Mutual-exclusion tooltip is present
    expect(commentBtn).toHaveAttribute(
      'title',
      'You have a review in progress — submit or discard it to post a single comment.',
    );

    // Clicking while review-in-progress is a no-op
    fireEvent.click(commentBtn);
    await settle(0);
    expect(commentApi.postComment).not.toHaveBeenCalled();
    expect(onPosted).not.toHaveBeenCalled();
  });

  // Case 3: prState='merged' → only "Comment" renders, no "Add to review", merged sub-label present
  it('merged PR: only "Comment" renders, no "Add to review", merged sub-label is shown', () => {
    render(<Harness prState="merged" />);

    // "Add to review" should NOT be present
    expect(screen.queryByRole('button', { name: 'Add to review' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add review comment' })).not.toBeInTheDocument();

    // "Comment" should be present
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();

    // Merged sub-label
    expect(screen.getByText(/PR is merged — comments post immediately/i)).toBeInTheDocument();
  });

  // Case 3b: prState='closed' → sub-label reads "PR is closed — comments post immediately"
  it('closed PR: sub-label reads "PR is closed — comments post immediately"', () => {
    render(<Harness prState="closed" />);

    // "Add to review" should NOT be present
    expect(screen.queryByRole('button', { name: 'Add to review' })).not.toBeInTheDocument();

    // "Comment" should be present
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();

    // Closed sub-label (not merged)
    expect(screen.getByText(/PR is closed — comments post immediately/i)).toBeInTheDocument();
    expect(screen.queryByText(/PR is merged — comments post immediately/i)).not.toBeInTheDocument();
  });

  // Case 4: Click "Comment" on a valid draft → full happy path
  it('clicking Comment on valid draft calls beginPosting, flush, postComment, onPosted, onClose, endPosting', async () => {
    const beginPosting = vi.fn();
    const endPosting = vi.fn();
    const onPosted = vi.fn();
    const onClose = vi.fn();

    // flush() is called via the sendPatch auto-save; mock it to return an id
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      assignedId: 'draft-uuid-1',
    });

    vi.mocked(commentApi.postComment).mockResolvedValue({
      ok: true,
      postedCommentId: 99,
    });

    render(
      <Harness
        prState="open"
        anyOtherDraftsStaged={false}
        beginPosting={beginPosting}
        endPosting={endPosting}
        onPosted={onPosted}
        onClose={onClose}
      />,
    );

    const commentBtn = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(commentBtn);

    await settle(0);

    expect(beginPosting).toHaveBeenCalledOnce();
    expect(commentApi.postComment).toHaveBeenCalledWith(ref, expect.any(String));
    expect(onPosted).toHaveBeenCalledWith(99, expect.any(String));
    expect(onClose).toHaveBeenCalledOnce();
    expect(endPosting).toHaveBeenCalledOnce();
  });

  // Case 5: postComment returns {ok:false} → error banner shows, composer stays open, endPosting called
  it('postComment failure shows role=alert error banner, does NOT close, endPosting is called', async () => {
    const endPosting = vi.fn();
    const onClose = vi.fn();

    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      assignedId: 'draft-uuid-1',
    });

    vi.mocked(commentApi.postComment).mockResolvedValue({
      ok: false,
      status: 422,
      code: 'post_failed',
      message: 'Could not post the comment right now.',
    });

    render(
      <Harness
        prState="open"
        anyOtherDraftsStaged={false}
        endPosting={endPosting}
        onClose={onClose}
      />,
    );

    const commentBtn = screen.getByRole('button', { name: 'Comment' });
    fireEvent.click(commentBtn);

    await settle(0);

    // Error banner with role="alert" is present
    const alert = screen.getByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(alert).toHaveTextContent('Could not post the comment right now.');

    // Composer is still open
    expect(onClose).not.toHaveBeenCalled();

    // endPosting always called (finally)
    expect(endPosting).toHaveBeenCalledOnce();
  });
});
