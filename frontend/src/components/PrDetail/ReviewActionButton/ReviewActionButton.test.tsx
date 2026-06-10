import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActionButton } from './ReviewActionButton';
import type { ReviewSessionDto } from '../../../api/types';

const session = (over: Partial<ReviewSessionDto> = {}): ReviewSessionDto => ({
  draftVerdict: null, draftVerdictStatus: 'draft', draftComments: [], draftReplies: [],
  iterationOverrides: [], pendingReviewId: null, pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} }, ...over,
});

const handlers = () => ({
  onPatchVerdict: vi.fn(), onOpenSubmit: vi.fn(), onResume: vi.fn(),
  onDiscardPending: vi.fn(), onDiscardAllDrafts: vi.fn(),
});

const props = (over = {}, h = handlers()) => ({
  session: session(), prState: 'open' as const, headShaDrift: false,
  validatorResults: [], inSubmitFlow: false, dialogOpen: false, ...h, ...over,
});

describe('ReviewActionButton — face', () => {
  it('default renders "Submit review", main disabled with reason (a) tooltip', () => {
    render(<ReviewActionButton {...props()} />);
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Submit review');
    expect(main).toBeDisabled();
    expect(main).toHaveAttribute('title', expect.stringMatching(/pick a verdict/i));
  });
  it('approve drafted → label Approve, enabled, click opens submit', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve' }) }, h)} />);
    await userEvent.click(screen.getByTestId('review-action-main'));
    expect(h.onOpenSubmit).toHaveBeenCalledOnce();
  });
  it('pending → trailing asterisk + pending tooltip, click resumes', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'comment', pendingReviewId: 'PR_1' }) }, h)} />);
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Comment*');
    expect(main).toHaveAttribute('title', expect.stringMatching(/pending review on github/i));
    await userEvent.click(main);
    expect(h.onResume).toHaveBeenCalledOnce();
  });
  it('needs-reconfirm → warning glyph present', () => {
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }) })} />);
    expect(screen.getByTestId('review-action-reconfirm')).toBeInTheDocument();
  });
});
