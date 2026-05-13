import { render, screen, fireEvent, act } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitDialog } from '../src/components/PrDetail/SubmitDialog/SubmitDialog';
import type { PrReference, ReviewSessionDto } from '../src/api/types';

const sendPatchMock = vi.fn();
vi.mock('../src/api/draft', async (orig) => {
  const actual = await orig<typeof import('../src/api/draft')>();
  return { ...actual, sendPatch: (...a: unknown[]) => sendPatchMock(...a) };
});

const reference: PrReference = { owner: 'o', repo: 'r', number: 1 };
type DialogProps = ComponentProps<typeof SubmitDialog>;

function session(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftSummaryMarkdown: null,
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
    ...overrides,
  };
}

function baseProps(overrides: Partial<DialogProps> = {}): DialogProps {
  return {
    open: true,
    reference,
    session: session({ draftVerdict: 'approve' }),
    validatorResults: [],
    submitState: { kind: 'idle' },
    onClose: vi.fn(),
    onSubmit: vi.fn(),
    onRetry: vi.fn(),
    onVerdictChange: vi.fn(),
    onResumeForeignPendingReview: vi.fn(),
    onDiscardForeignPendingReview: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  sendPatchMock.mockReset().mockResolvedValue({ ok: true, assignedId: null });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('SubmitDialog', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<SubmitDialog {...baseProps({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders inside the Modal shell with the .submit-dialog marker the § 8.5 720px width keys on', () => {
    // jsdom doesn't load tokens.css, so a getComputedStyle().maxWidth check
    // wouldn't see the rule; this pins the structural hook the CSS
    // (`.modal-dialog:has(.submit-dialog) { max-width: 720px }`) targets so
    // the width contract can't drift unnoticed.
    render(<SubmitDialog {...baseProps()} />);
    expect(document.querySelector('.modal-dialog .submit-dialog')).not.toBeNull();
  });

  it('renders body sections in spec § 8.1 order: verdict → summary → counts', () => {
    const { container } = render(<SubmitDialog {...baseProps()} />);
    const sections = Array.from(container.querySelectorAll('[data-section]')).map((el) =>
      el.getAttribute('data-section'),
    );
    expect(sections.indexOf('verdict')).toBeGreaterThanOrEqual(0);
    expect(sections.indexOf('verdict')).toBeLessThan(sections.indexOf('summary'));
    expect(sections.indexOf('summary')).toBeLessThan(sections.indexOf('counts'));
  });

  it('idle state: Cancel + Confirm submit are present and enabled with a ready session', () => {
    render(<SubmitDialog {...baseProps()} />);
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeEnabled();
  });

  it('Confirm submit is disabled when the § 9 rules block (Comment verdict + no content)', () => {
    render(<SubmitDialog {...baseProps({ session: session({ draftVerdict: 'comment' }) })} />);
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeDisabled();
  });

  it('Confirm re-evaluates against the live textarea — clearing the only content disables it', () => {
    // Session's only "content" is the saved summary; the picker has no verdict.
    render(
      <SubmitDialog
        {...baseProps({ session: session({ draftVerdict: null, draftSummaryMarkdown: 'LGTM' }) })}
      />,
    );
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeEnabled();
    fireEvent.change(screen.getByLabelText(/pr-level summary/i), { target: { value: '' } });
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeDisabled();
  });

  it('Confirm follows rule (f) when head_sha drift develops while the dialog is open', () => {
    const { rerender } = render(<SubmitDialog {...baseProps()} />);
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeEnabled();
    rerender(<SubmitDialog {...baseProps({ headShaDrift: true })} />);
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeDisabled();
  });

  it('clicking Confirm flushes the summary then fires onSubmit with the PascalCase verdict', async () => {
    const onSubmit = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({ onSubmit, session: session({ draftVerdict: 'request-changes' }) })}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm submit/i }));
    });
    expect(sendPatchMock).toHaveBeenCalledWith(
      reference,
      expect.objectContaining({ kind: 'draftSummaryMarkdown' }),
    );
    expect(onSubmit).toHaveBeenCalledWith('RequestChanges');
  });

  it('changing the verdict picker calls onVerdictChange with the kebab value', () => {
    const onVerdictChange = vi.fn();
    render(<SubmitDialog {...baseProps({ onVerdictChange })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onVerdictChange).toHaveBeenCalledWith('comment');
  });

  it('typing in the summary textarea debounce-saves to draftSummaryMarkdown', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    render(<SubmitDialog {...baseProps()} />);
    const textarea = screen.getByLabelText(/pr-level summary/i);
    fireEvent.change(textarea, { target: { value: 'Looks good' } });
    expect(sendPatchMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(250));
    expect(sendPatchMock).toHaveBeenCalledWith(reference, {
      kind: 'draftSummaryMarkdown',
      payload: 'Looks good',
    });
  });

  it('renders the summary live preview', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftSummaryMarkdown: 'hello **world**' }),
        })}
      />,
    );
    const preview = document.querySelector('[data-section="summary-preview"]');
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain('hello');
    expect(preview!.querySelector('strong')?.textContent).toBe('world');
  });

  it('in-flight Phase A: neutral indicator, Cancel disabled, no Confirm, Submitting spinner', () => {
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'in-flight', steps: [] } })} />);
    expect(screen.getByText(/checking pending review state/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /confirm submit/i })).not.toBeInTheDocument();
    expect(screen.getByText(/^submitting…$/i)).toBeInTheDocument();
  });

  it('in-flight: keeps focus inside the dialog even though every control is disabled', () => {
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'in-flight', steps: [] } })} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it('in-flight Phase B: the 5-row checklist replaces the neutral indicator', () => {
    const steps = [
      {
        step: 'DetectExistingPendingReview' as const,
        status: 'Succeeded' as const,
        done: 1,
        total: 1,
      },
      { step: 'BeginPendingReview' as const, status: 'Succeeded' as const, done: 1, total: 1 },
    ];
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'in-flight', steps } })} />);
    expect(screen.queryByText(/checking pending review state/i)).not.toBeInTheDocument();
    expect(screen.getByText(/attach threads/i)).toBeInTheDocument();
    expect(screen.getByText(/finalize/i)).toBeInTheDocument();
  });

  it('success state: View on GitHub link + Close button, no Cancel, all-✓ checklist still shown', () => {
    const doneSteps = (
      [
        'DetectExistingPendingReview',
        'BeginPendingReview',
        'AttachThreads',
        'AttachReplies',
        'Finalize',
      ] as const
    ).map((step) => ({ step, status: 'Succeeded' as const, done: 1, total: 1 }));
    render(
      <SubmitDialog
        {...baseProps({
          submitState: { kind: 'success', pullRequestReviewId: '', steps: doneSteps },
        })}
      />,
    );
    expect(screen.getByRole('link', { name: /view on github/i })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/1',
    );
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
    expect(screen.getByText(/created pending review/i)).toBeInTheDocument();
  });

  it('failed state: Cancel re-enabled, Retry button, checklist still visible', () => {
    render(
      <SubmitDialog
        {...baseProps({
          submitState: {
            kind: 'failed',
            failedStep: 'AttachThreads',
            errorMessage: 'boom',
            steps: [
              { step: 'DetectExistingPendingReview', status: 'Succeeded', done: 1, total: 1 },
              { step: 'BeginPendingReview', status: 'Succeeded', done: 1, total: 1 },
              { step: 'AttachThreads', status: 'Failed', done: 0, total: 2, errorMessage: 'boom' },
            ],
          },
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    expect(screen.getByText(/boom/)).toBeInTheDocument();
  });

  it('stale-commit-oid state: StaleCommitOidBanner replaces the body, Recreate-and-resubmit + Cancel, sha shown', () => {
    render(
      <SubmitDialog
        {...baseProps({
          submitState: { kind: 'stale-commit-oid', orphanCommitOid: 'old' },
          currentHeadSha: 'feedface1234567',
        })}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/head commit changed/i);
    expect(screen.getByRole('alert')).toHaveTextContent('feedfac');
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
    // The body sections are gone — no verdict picker / summary while in this state.
    expect(screen.queryByLabelText(/pr-level summary/i)).not.toBeInTheDocument();
  });

  it('stale-commit-oid state: Esc dismisses (nothing was submitted; no editable content to protect)', () => {
    const onClose = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({
          submitState: { kind: 'stale-commit-oid', orphanCommitOid: 'old' },
          currentHeadSha: 'feedface',
          onClose,
        })}
      />,
    );
    // The SubmitDialog-level window Esc handler is skipped for this kind; the
    // shared <Modal>'s document-level handler dismisses (disableEscDismiss off).
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('stale-commit-oid with head_sha drift still pending: Recreate disabled + Reload reminder', () => {
    render(
      <SubmitDialog
        {...baseProps({
          submitState: { kind: 'stale-commit-oid', orphanCommitOid: 'old' },
          currentHeadSha: 'feedface',
          headShaDrift: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeDisabled();
    expect(screen.getByText(/click reload first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
  });

  it('foreign-pending-review-prompt state: renders the ForeignPendingReviewModal (not the submit dialog body)', () => {
    const onResumeForeignPendingReview = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({
          submitState: {
            kind: 'foreign-pending-review-prompt',
            snapshot: {
              prRef: 'o/r/1',
              pullRequestReviewId: 'PRR_a',
              commitOid: 'c',
              createdAt: '2026-05-11T00:00:00Z',
              threadCount: 2,
              replyCount: 0,
            },
          },
          onResumeForeignPendingReview,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /^resume$/i })).toBeInTheDocument();
    expect(screen.getByText(/2 thread/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/pr-level summary/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^resume$/i }));
    expect(onResumeForeignPendingReview).toHaveBeenCalledWith('PRR_a');
  });

  it('Esc focuses Cancel instead of dismissing, and announces the focus shift', () => {
    const onClose = vi.fn();
    render(<SubmitDialog {...baseProps({ onClose })} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.getByRole('status').textContent).toMatch(/esc moved focus to cancel/i);
  });
});
