// CollapsedComposerAffordance.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { CollapsedComposerAffordance } from './CollapsedComposerAffordance';

describe('CollapsedComposerAffordance', () => {
  it('is a button with the given label + aria-label and opens on click', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance label="Reply…" ariaLabel="Reply to thread" onOpen={onOpen} />,
    );
    const btn = screen.getByRole('button', { name: 'Reply to thread' });
    expect(btn).toHaveTextContent('Reply…');
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });

  it('shows the saved pill and continue-draft label when a draft exists', () => {
    render(
      <CollapsedComposerAffordance
        label="Continue draft…"
        ariaLabel="Reply to thread"
        hasDraft
        onOpen={() => {}}
      />,
    );
    expect(screen.getByText('Continue draft…')).toBeInTheDocument();
    expect(screen.getByText('saved')).toBeInTheDocument();
  });

  it('is truly inert under readOnly — natively disabled, out of tab order, no open on click', () => {
    const onOpen = vi.fn();
    render(
      <CollapsedComposerAffordance
        label="Reply…"
        ariaLabel="Reply to thread"
        readOnly
        onOpen={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Reply to thread' });
    // Native `disabled` removes it from the tab order and lets assistive tech
    // announce it as disabled — not a focusable button that silently no-ops.
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onOpen).not.toHaveBeenCalled();
  });

  // #302 Task 12 Part B — affordance has NO prState prop (intentionally).
  //
  // Design rationale: the affordance is only the "Reply…" trigger button; all
  // merged/closed-PR behaviour lives in ReplyComposer (which receives prState
  // from replyContext directly via ExistingCommentWidget). On a merged PR the
  // affordance remains clickable — clicking it mounts ReplyComposer which
  // immediately shows the post-now-only UI (no "Add to review" save button,
  // closed banner, "Comment" button only). Adding prState to the affordance
  // would gate a button whose click already opens a correctly-restricted
  // composer — dead code.
  //
  // Acceptance: ReplyComposer.postNow.test.tsx Case 3 already verifies that a
  // merged-prState composer renders only "Comment". This test confirms the
  // other half: the affordance itself fires onOpen regardless of PR state
  // (prState is not and should not be a prop here).
  it('fires onOpen regardless of surrounding PR state — prState gating belongs in ReplyComposer, not the affordance', () => {
    const onOpen = vi.fn();
    // The affordance has no prState prop; simulate a merged context by just
    // confirming it is clickable (not disabled by anything other than readOnly).
    render(
      <CollapsedComposerAffordance
        label="Reply…"
        ariaLabel="Reply to thread on merged PR"
        onOpen={onOpen}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Reply to thread on merged PR' });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
