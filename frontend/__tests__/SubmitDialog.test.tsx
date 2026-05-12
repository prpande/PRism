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
      <SubmitDialog {...baseProps({ session: session({ draftVerdict: 'approve', draftSummaryMarkdown: 'hello **world**' }) })} />,
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

  it('in-flight Phase B: the 5-row checklist replaces the neutral indicator', () => {
    const steps = [
      { step: 'DetectExistingPendingReview' as const, status: 'Succeeded' as const, done: 1, total: 1 },
      { step: 'BeginPendingReview' as const, status: 'Succeeded' as const, done: 1, total: 1 },
    ];
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'in-flight', steps } })} />);
    expect(screen.queryByText(/checking pending review state/i)).not.toBeInTheDocument();
    expect(screen.getByText(/attach threads/i)).toBeInTheDocument();
    expect(screen.getByText(/finalize/i)).toBeInTheDocument();
  });

  it('success state: View on GitHub link + Close button, no Cancel', () => {
    render(<SubmitDialog {...baseProps({ submitState: { kind: 'success', pullRequestReviewId: '' } })} />);
    expect(screen.getByRole('link', { name: /view on github/i })).toHaveAttribute(
      'href',
      'https://github.com/o/r/pull/1',
    );
    expect(screen.getByRole('button', { name: /close/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^cancel$/i })).not.toBeInTheDocument();
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

  it('stale-commit-oid state: warning banner, Recreate-and-resubmit primary, Cancel enabled', () => {
    render(
      <SubmitDialog {...baseProps({ submitState: { kind: 'stale-commit-oid', orphanCommitOid: 'old' } })} />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent(/head commit changed/i);
    expect(screen.getByRole('button', { name: /recreate and resubmit/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /cancel/i })).toBeEnabled();
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
