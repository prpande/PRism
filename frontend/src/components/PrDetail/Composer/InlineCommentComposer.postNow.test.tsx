import { render, screen, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useState } from 'react';
import { InlineCommentComposer, type InlineAnchor } from './InlineCommentComposer';
import * as draftApi from '../../../api/draft';
import * as commentApi from '../../../api/comment';
import type { PrReference } from '../../../api/types';

vi.mock('../../../api/comment');

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

    // #390 — the merged note is gone; the "posts immediately" context now lives
    // on the Comment button's tooltip (keeps "Comment" as the accessible name).
    expect(screen.queryByText(/comments post immediately/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'title',
      'Post directly to this merged PR',
    );
  });

  // Case 3b: prState='closed' → sub-label reads "PR is closed — comments post immediately"
  it('closed PR: sub-label reads "PR is closed — comments post immediately"', () => {
    render(<Harness prState="closed" />);

    // "Add to review" should NOT be present
    expect(screen.queryByRole('button', { name: 'Add to review' })).not.toBeInTheDocument();

    // "Comment" should be present
    expect(screen.getByRole('button', { name: 'Comment' })).toBeInTheDocument();

    // #390 — closed context on the Comment button's tooltip (not merged).
    expect(screen.queryByText(/comments post immediately/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Comment' })).toHaveAttribute(
      'title',
      'Post directly to this closed PR',
    );
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

  // Case 6 (#302): post-now on a merged PR stages the draft and posts it
  it('merged PR: clicking Comment stages the draft via sendPatch and calls postComment with the id', async () => {
    const beginPosting = vi.fn();
    const endPosting = vi.fn();
    const onPosted = vi.fn();
    const onClose = vi.fn();

    // The composer has no pre-existing draftId; flush() must create one via sendPatch.
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({
      ok: true,
      assignedId: 'new-merged-draft-id',
    });

    vi.mocked(commentApi.postComment).mockResolvedValue({
      ok: true,
      postedCommentId: 77,
    });

    render(
      <Harness
        prState="merged"
        initialDraftId={null}
        initialBody="looks good!"
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

    // sendPatch must have been called (draft was staged)
    expect(draftApi.sendPatch).toHaveBeenCalledWith(
      ref,
      expect.objectContaining({ kind: 'newDraftComment' }),
    );

    // postComment must have been called with the id returned by sendPatch
    expect(commentApi.postComment).toHaveBeenCalledWith(ref, 'new-merged-draft-id');

    // Full happy path
    expect(beginPosting).toHaveBeenCalledOnce();
    expect(onPosted).toHaveBeenCalledWith(77, 'looks good!');
    expect(onClose).toHaveBeenCalledOnce();
    expect(endPosting).toHaveBeenCalledOnce();
  });
});

describe('InlineCommentComposer — textarea locked during in-flight post (#644)', () => {
  // #644: the inline textarea reflected only the cross-tab readOnly flag, not
  // `posting`. A keystroke during a post mutated `body` → scheduled a debounced
  // updateDraftComment PUT that raced the in-flight post. The lock is the DOM
  // `readOnly` attribute ONLY — the autosave hook's `disabled` stays cross-tab
  // only, so #601 Fix A's mid-flush 404 detection (driven by the post-now flush)
  // stays live.
  function startInFlightPost() {
    let resolvePost: (v: { ok: true; postedCommentId: number }) => void = () => undefined;
    const sendPatch = vi
      .spyOn(draftApi, 'sendPatch')
      .mockResolvedValue({ ok: true, assignedId: 'draft-uuid-1' });
    vi.mocked(commentApi.postComment).mockImplementation(
      () => new Promise((res) => (resolvePost = res)),
    );
    return { sendPatch, resolvePost: () => resolvePost({ ok: true, postedCommentId: 5 }) };
  }

  // The DOM `readOnly` attribute IS the lock: a read-only textarea cannot fire a
  // user-input onChange, so `body` can't change → the body-keyed debounce never
  // re-arms → no update PUT races the post (AC: "typing fires no PUT"). jsdom's
  // fireEvent bypasses readOnly and userEvent deadlocks against fake timers, so
  // the attribute assertion is the deterministic proof of the mechanism.
  it('marks the textarea read-only while a post is in flight', async () => {
    const { resolvePost } = startInFlightPost();
    render(<Harness prState="open" initialDraftId="draft-uuid-1" />);

    const textarea = screen.getByLabelText('Comment body');
    // Editable before the post starts.
    expect(textarea).not.toHaveAttribute('readonly');

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await settle(0); // flush() resolves; postComment dispatched and now pending

    expect(textarea).toHaveAttribute('readonly');

    await act(async () => {
      resolvePost();
      await Promise.resolve();
    });
  });

  // Complements the lock test: the lock is scoped to the post window, so a failed
  // post (which leaves the composer open) restores an editable textarea.
  it('re-enables the textarea after a failed post', async () => {
    vi.spyOn(draftApi, 'sendPatch').mockResolvedValue({ ok: true, assignedId: 'draft-uuid-1' });
    vi.mocked(commentApi.postComment).mockResolvedValue({
      ok: false,
      status: 422,
      code: 'post_failed',
      message: 'Could not post the comment right now.',
    });
    render(<Harness prState="open" initialDraftId="draft-uuid-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    await settle(0); // post fails → posting back to false

    expect(screen.getByLabelText('Comment body')).not.toHaveAttribute('readonly');
  });
});
