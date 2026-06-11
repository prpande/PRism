import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubmitDialog } from '../src/components/PrDetail/SubmitDialog/SubmitDialog';
import type { ComposerOwnerKey } from '../src/hooks/useDraftSession';
import type { DraftCommentDto, PrReference, ReviewSessionDto } from '../src/api/types';

// Mock the wrapped editor so we can drive its callbacks (onBodyChange,
// onAutosaveControl, onDraftLost) directly and assert orchestration without
// re-testing PrRootBodyEditor's own behavior (covered in its own file).
const editorFlush = vi.fn().mockResolvedValue(undefined);
let lastEditorProps: Record<string, unknown> | null = null;
vi.mock('../src/components/PrDetail/Composer/PrRootBodyEditor', () => ({
  PrRootBodyEditor: (p: Record<string, unknown>) => {
    lastEditorProps = p;
    // Surface the autosave control synchronously on mount.
    const onAutosaveControl = p.onAutosaveControl as
      | ((c: { flush: () => Promise<string | null>; badge: string }) => void)
      | undefined;
    onAutosaveControl?.({ flush: editorFlush, badge: 'saved' });
    return (
      <textarea
        aria-label="PR-level body"
        data-testid="mock-editor"
        defaultValue={(p.initialBody as string) ?? ''}
        onChange={(e) => (p.onBodyChange as (b: string) => void)?.(e.target.value)}
      />
    );
  },
}));

const reference: PrReference = { owner: 'o', repo: 'r', number: 1 };
type DialogProps = ComponentProps<typeof SubmitDialog>;

function prRootDraft(overrides: Partial<DraftCommentDto> = {}): DraftCommentDto {
  return {
    id: 'draft-root',
    filePath: null,
    lineNumber: null,
    bodyMarkdown: 'hello **world**',
    status: 'fresh',
    isOverriddenStale: false,
    anchoredSha: null,
    ...overrides,
  } as DraftCommentDto;
}

function session(overrides: Partial<ReviewSessionDto> = {}): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
    ...overrides,
  } as ReviewSessionDto;
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
  lastEditorProps = null;
  editorFlush.mockClear().mockResolvedValue(undefined);
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

  // NEGATIVE: the old summary textarea is gone post-V7.
  it('no longer renders the old PR-level summary textarea', () => {
    render(<SubmitDialog {...baseProps()} />);
    expect(screen.queryByLabelText(/pr-level summary/i)).toBeNull();
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

  it('Confirm follows rule (f) when head_sha drift develops while the dialog is open', () => {
    const { rerender } = render(<SubmitDialog {...baseProps()} />);
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeEnabled();
    rerender(<SubmitDialog {...baseProps({ headShaDrift: true })} />);
    expect(screen.getByRole('button', { name: /confirm submit/i })).toBeDisabled();
  });

  it('clicking Confirm fires onSubmit with the kebab-case verdict', async () => {
    const onSubmit = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({ onSubmit, session: session({ draftVerdict: 'request-changes' }) })}
      />,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm submit/i }));
    });
    expect(onSubmit).toHaveBeenCalledWith('request-changes');
  });

  it('changing the verdict picker calls onVerdictChange with the kebab value', () => {
    const onVerdictChange = vi.fn();
    render(<SubmitDialog {...baseProps({ onVerdictChange })} />);
    fireEvent.click(screen.getByRole('button', { name: 'Comment' }));
    expect(onVerdictChange).toHaveBeenCalledWith('comment');
  });

  // ---- Preview ----------------------------------------------------------
  it('preview: renders the PR-root draft body via MarkdownRenderer when present', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    const preview = document.querySelector('[data-section="summary-preview"]');
    expect(preview).not.toBeNull();
    expect(preview!.textContent).toContain('hello');
    expect(preview!.querySelector('strong')?.textContent).toBe('world');
  });

  it('preview: renders the placeholder when no PR-root body exists', () => {
    render(<SubmitDialog {...baseProps()} />);
    expect(screen.getByText(/no pr-level body — click edit to add one/i)).toBeInTheDocument();
  });

  // ---- Edit toggle ------------------------------------------------------
  it('clicking Edit mounts PrRootBodyEditor; Done returns to the preview', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    expect(screen.getByLabelText('PR-level body')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pr-root-done-toggle'));
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  // ---- In-session preview update (live editingBody) ---------------------
  // After Edit → type → Done, the preview must re-render from the live
  // editingBody (the typed text), not the stale session-derived draft body.
  // The own-tab state-changed SSE is filtered, so the session prop isn't
  // refetched until a navigation/reopen — without this, the preview would show
  // the pre-edit body and defeat the inline-edit feature.
  it('preview reflects the live edited body after Edit → type → Done (no reopen)', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    // Sanity: the pre-edit preview shows the seeded draft body.
    const previewBefore = document.querySelector('[data-section="summary-preview"]');
    expect(previewBefore!.textContent).toContain('hello');

    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    // Drive the mocked editor's onBodyChange with new text.
    fireEvent.change(screen.getByTestId('mock-editor'), {
      target: { value: 'a brand new **body**' },
    });
    fireEvent.click(screen.getByTestId('pr-root-done-toggle'));

    const previewAfter = document.querySelector('[data-section="summary-preview"]');
    expect(previewAfter!.textContent).toContain('a brand new');
    expect(previewAfter!.querySelector('strong')?.textContent).toBe('body');
    // The pre-edit body is gone from the preview.
    expect(previewAfter!.textContent).not.toContain('hello');
  });

  it('preview falls back to the placeholder when the body is edited down to empty', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    fireEvent.change(screen.getByTestId('mock-editor'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('pr-root-done-toggle'));
    expect(screen.getByText(/no pr-level body — click edit to add one/i)).toBeInTheDocument();
  });

  it('Edit mounts the editor with ownerKey=submit-dialog and key derived from the draft id', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    expect(lastEditorProps?.ownerKey).toBe('submit-dialog');
    expect(lastEditorProps?.draftId).toBe('draft-root');
    expect(lastEditorProps?.initialBody).toBe('hello **world**');
  });

  // ---- Cross-surface + cross-tab lock -----------------------------------
  it('cross-surface lock: Edit disabled with the overview-composer tooltip when reply-composer holds the draft', () => {
    const getPrRootHolder = (): ComposerOwnerKey | null => 'reply-composer';
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
          getPrRootHolder,
        })}
      />,
    );
    const edit = screen.getByTestId('pr-root-edit-toggle');
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Close the Overview composer to edit here.');
  });

  it('cross-tab readOnly: Edit disabled with the other-tab tooltip', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
          readOnly: true,
        })}
      />,
    );
    const edit = screen.getByTestId('pr-root-edit-toggle');
    expect(edit).toBeDisabled();
    expect(edit).toHaveAttribute('title', 'Another tab is editing this PR.');
  });

  // ---- Close-while-editing flush ----------------------------------------
  it('Close while editing awaits the editor flush before onClose', async () => {
    const order: string[] = [];
    const onClose = vi.fn(() => {
      order.push('close');
    });
    editorFlush.mockImplementation(async () => {
      order.push('flush');
    });
    render(
      <SubmitDialog
        {...baseProps({
          onClose,
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(order).toEqual(['flush', 'close']);
  });

  it('Close while editing still calls onClose when the editor flush rejects (autosave failure does not trap the user)', async () => {
    const onClose = vi.fn();
    editorFlush.mockRejectedValue(new Error('save failed'));
    render(
      <SubmitDialog
        {...baseProps({
          onClose,
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(editorFlush).toHaveBeenCalled();
  });

  it('Close in preview (not editing) calls onClose without flushing', () => {
    const onClose = vi.fn();
    render(<SubmitDialog {...baseProps({ onClose })} />);
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(onClose).toHaveBeenCalled();
    expect(editorFlush).not.toHaveBeenCalled();
  });

  // ---- onDraftLost → preview --------------------------------------------
  it('onDraftLost returns the dialog to preview', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', draftComments: [prRootDraft()] }),
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('pr-root-edit-toggle'));
    expect(screen.getByTestId('mock-editor')).toBeInTheDocument();
    act(() => {
      (lastEditorProps?.onDraftLost as () => void)?.();
    });
    expect(screen.queryByTestId('mock-editor')).toBeNull();
  });

  // ---- Discard footer ---------------------------------------------------
  it('Discard footer button is present when a pending review exists', () => {
    render(
      <SubmitDialog
        {...baseProps({ session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }) })}
      />,
    );
    expect(screen.getByTestId('dialog-discard')).toBeInTheDocument();
  });

  it('Discard footer button is present while a submit is in flight', () => {
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'in-flight', steps: [] } })} />);
    expect(screen.getByTestId('dialog-discard')).toBeInTheDocument();
  });

  it('Discard footer button is absent with no pending review and idle submit', () => {
    render(<SubmitDialog {...baseProps()} />);
    expect(screen.queryByTestId('dialog-discard')).toBeNull();
  });

  it('clicking Discard opens the confirmation modal', () => {
    render(
      <SubmitDialog
        {...baseProps({ session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }) })}
      />,
    );
    fireEvent.click(screen.getByTestId('dialog-discard'));
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
  });

  it('confirming Discard calls discardOwnPendingReview; success closes dialog + fires the toast', async () => {
    const discardOwnPendingReview = vi.fn().mockResolvedValue({ ok: true });
    const onDiscardSuccess = vi.fn();
    const onClose = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }),
          discardOwnPendingReview,
          onDiscardSuccess,
          onClose,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('dialog-discard'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-discard-pending'));
    });
    expect(discardOwnPendingReview).toHaveBeenCalled();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(onDiscardSuccess).toHaveBeenCalled();
  });

  it('failed Discard surfaces the modal error and does not close the dialog', async () => {
    const discardOwnPendingReview = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'github-forbidden', message: 'Forbidden' });
    const onClose = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }),
          discardOwnPendingReview,
          onClose,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('dialog-discard'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-discard-pending'));
    });
    expect(screen.getByTestId('discard-pending-error')).toHaveTextContent(
      "Couldn't discard: Forbidden.",
    );
    expect(onClose).not.toHaveBeenCalled();
  });

  it('strips a trailing period from the API message so the modal never shows ".."', async () => {
    const discardOwnPendingReview = vi
      .fn()
      .mockResolvedValue({ ok: false, code: 'github-network-error', message: 'Network failed.' });
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }),
          discardOwnPendingReview,
        })}
      />,
    );
    fireEvent.click(screen.getByTestId('dialog-discard'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-discard-pending'));
    });
    const err = screen.getByTestId('discard-pending-error');
    expect(err).toHaveTextContent("Couldn't discard: Network failed.");
    expect(err.textContent).not.toContain('..');
  });

  // ---- Close blocked while discardInFlight ------------------------------
  it('Cancel is disabled and onClose is blocked while a discard is in flight', () => {
    const onClose = vi.fn();
    render(
      <SubmitDialog
        {...baseProps({
          session: session({ draftVerdict: 'approve', pendingReviewId: 'PRR_1' }),
          discardInFlight: true,
          onClose,
        })}
      />,
    );
    const cancel = screen.getByRole('button', { name: /^cancel$/i });
    expect(cancel).toBeDisabled();
    fireEvent.click(cancel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('shows the "Cancelling…" sequencing label when a discard runs during an in-flight submit', () => {
    render(
      <SubmitDialog
        {...baseProps({
          submitState: { kind: 'in-flight', steps: [] },
          discardInFlight: true,
        })}
      />,
    );
    expect(screen.getByText(/^cancelling…$/i)).toBeInTheDocument();
  });

  // ---- Existing lifecycle coverage --------------------------------------
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
          htmlUrl: 'https://github.com/o/r/pull/1',
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

  it('View on GitHub link uses htmlUrl, not a hardcoded host', () => {
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
          htmlUrl: 'https://github.example.com/acme/api/pull/123',
        })}
      />,
    );
    const link = screen.getByRole('link', { name: /view on github/i });
    expect(link).toHaveAttribute('href', 'https://github.example.com/acme/api/pull/123');
  });

  it('success state omits the View on GitHub link when htmlUrl is absent', () => {
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
    expect(screen.queryByRole('link', { name: /view on github/i })).toBeNull();
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
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

  // CountsBlock thread count must EXCLUDE the PR-root draft (filePath/lineNumber
  // null): it ships as the review body, not a thread (StepAttachThreadsAsync
  // filters it out). With 2 inline drafts + 1 PR-root draft the dialog must say
  // "2 new threads", not "3". Pre-fix this asserted 3 and would fail.
  it('CountsBlock thread count excludes the PR-root draft', () => {
    render(
      <SubmitDialog
        {...baseProps({
          session: session({
            draftVerdict: 'approve',
            draftComments: [
              prRootDraft({ id: 'inline-1', filePath: 'a.ts', lineNumber: 10 }),
              prRootDraft({ id: 'inline-2', filePath: 'b.ts', lineNumber: 20 }),
              prRootDraft(),
            ],
          }),
        })}
      />,
    );
    const counts = document.querySelector('[data-section-counts]');
    expect(counts).not.toBeNull();
    expect(counts?.textContent).toMatch(/create 2 new threads/i);
    expect(counts?.textContent).not.toMatch(/3 new threads/i);
  });
});
