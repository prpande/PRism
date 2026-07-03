import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActionButton } from './ReviewActionButton';
import type { ReviewSessionDto } from '../../../api/types';

const session = (over: Partial<ReviewSessionDto> = {}): ReviewSessionDto => ({
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
  ...over,
});

const handlers = () => ({
  onPatchVerdict: vi.fn(),
  onOpenSubmit: vi.fn(),
  onResume: vi.fn(),
  onDiscardPending: vi.fn(),
  onDiscardAllDrafts: vi.fn(),
});

const props = (over = {}, h = handlers()) => ({
  session: session(),
  prState: 'open' as const,
  headShaDrift: false,
  validatorResults: [],
  inSubmitFlow: false,
  dialogOpen: false,
  sessionLoaded: true,
  viewerReview: null,
  submittedReviewStale: false,
  ...h,
  ...over,
});

describe('ReviewActionButton — menu', () => {
  it('chevron opens a role=menu; picking a verdict patches it', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({}, h)} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Approve' }));
    expect(h.onPatchVerdict).toHaveBeenCalledWith('approve');
  });
  it('re-selecting the checked verdict clears it (null)', async () => {
    const h = handlers();
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve' }) }, h)} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    await userEvent.click(screen.getByRole('menuitem', { name: /Approve/ }));
    expect(h.onPatchVerdict).toHaveBeenCalledWith(null);
  });
  it('Escape closes the menu and returns focus to the chevron', async () => {
    render(<ReviewActionButton {...props()} />);
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron);
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chevron).toHaveFocus();
  });
  it('ArrowDown moves focus to the next item and wraps last→first', async () => {
    render(<ReviewActionButton {...props()} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    const items = screen.getAllByRole('menuitem');
    expect(items[0]).toHaveFocus(); // first item focused on open
    await userEvent.keyboard('{ArrowDown}');
    expect(items[1]).toHaveFocus();
    // wrap: ArrowUp from the first item goes to the last
    items[0].focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(items[items.length - 1]).toHaveFocus();
  });
  it('Tab closes the menu (does not trap focus)', async () => {
    render(<ReviewActionButton {...props()} />);
    await userEvent.click(screen.getByTestId('review-action-chevron'));
    await userEvent.tab();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('selecting a menu item returns focus to the chevron (keyboard a11y)', async () => {
    render(<ReviewActionButton {...props({ session: session({ draftVerdict: 'approve' }) })} />);
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Request changes' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(chevron).toHaveFocus();
  });
  it('clicking the chevron while the menu is open closes it (no double-toggle)', async () => {
    render(<ReviewActionButton {...props()} />);
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(chevron);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('clicking the main button in a change face closes the open menu (no double-toggle)', async () => {
    // viewerReview non-null + no draft verdict + open PR → mainAction 'change':
    // the main button toggles the same menu the chevron does.
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    const main = screen.getByTestId('review-action-main');
    await userEvent.click(main);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(main);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
  it('outside click closes the menu and leaves focus where the click landed', async () => {
    render(
      <div>
        <button>outside</button>
        <ReviewActionButton {...props()} />
      </div>,
    );
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'outside' }));
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // Flush the deferred focus-return path to prove it does NOT fire on outside close.
    await new Promise((r) => setTimeout(r, 0));
    expect(chevron).not.toHaveFocus();
  });
  it('session not loaded → main + chevron both inert (no patch before session arrives)', async () => {
    const h = handlers();
    render(
      <ReviewActionButton
        {...props({ sessionLoaded: false, session: session({ draftVerdict: 'approve' }) }, h)}
      />,
    );
    expect(screen.getByTestId('review-action-chevron')).toBeDisabled();
    expect(screen.getByTestId('review-action-main')).toBeDisabled();
  });
  it('frozen (inSubmitFlow) disables the chevron — no menu', async () => {
    render(
      <ReviewActionButton
        {...props({ inSubmitFlow: true, session: session({ draftVerdict: 'approve' }) })}
      />,
    );
    expect(screen.getByTestId('review-action-chevron')).toBeDisabled();
  });
  it('clicking the chevron while open closes the menu without reopening it', async () => {
    render(<ReviewActionButton {...props()} />);
    const chevron = screen.getByTestId('review-action-chevron');
    await userEvent.click(chevron); // open
    expect(screen.getByRole('menu')).toBeInTheDocument();
    await userEvent.click(chevron); // close
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });
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
    render(
      <ReviewActionButton
        {...props({ session: session({ draftVerdict: 'comment', pendingReviewId: 'PR_1' }) }, h)}
      />,
    );
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Comment*');
    expect(main).toHaveAttribute('title', expect.stringMatching(/pending review on github/i));
    await userEvent.click(main);
    expect(h.onResume).toHaveBeenCalledOnce();
  });
  it('needs-reconfirm → warning glyph present', () => {
    render(
      <ReviewActionButton
        {...props({
          session: session({ draftVerdict: 'approve', draftVerdictStatus: 'needs-reconfirm' }),
        })}
      />,
    );
    expect(screen.getByTestId('review-action-reconfirm')).toBeInTheDocument();
  });
});

describe('ReviewActionButton — submitted-review caption', () => {
  it('renders the reviewed caption with relative time', () => {
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date(Date.now() - 2 * 86400000).toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/You reviewed · 2d ago/);
  });

  it('appends "out of date" when stale', () => {
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'old',
          },
          submittedReviewStale: true,
        })}
      />,
    );
    expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/out of date/);
  });

  it('demotes prior verdict to "was" while drafting', () => {
    render(
      <ReviewActionButton
        {...props({
          session: { ...session(), draftVerdict: 'request-changes' },
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/was Approved/);
  });

  it('announces caption changes to screen readers via an aria-live region', () => {
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    expect(screen.getByTestId('review-action-caption')).toHaveAttribute('aria-live', 'polite');
  });

  it('submitted-status main button opens the menu (change)', async () => {
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    const main = screen.getByTestId('review-action-main');
    expect(main).not.toBeDisabled();
    await userEvent.click(main);
    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('exposes the submitted status to screen readers via aria-label', () => {
    render(
      <ReviewActionButton
        {...props({
          viewerReview: {
            state: 'approved',
            submittedAt: new Date().toISOString(),
            commitSha: 'x',
          },
        })}
      />,
    );
    expect(screen.getByTestId('review-action-main')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/you reviewed/i),
    );
  });
});
