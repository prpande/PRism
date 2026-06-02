import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrHeader } from '../src/components/PrDetail/PrHeader';
import { ToastProvider } from '../src/components/Toast/useToast';
import { ToastContainer } from '../src/components/Toast/ToastContainer';
import { AskAiDrawerProvider } from '../src/contexts/AskAiDrawerContext';
import type { ReactNode } from 'react';
import type {
  AiCapabilities,
  PrReference,
  PreferencesResponse,
  ReviewSessionDto,
} from '../src/api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error.
const { capabilitiesValue, preferencesValue, submitReviewMock, discardOwnPendingReviewMock } =
  vi.hoisted(() => ({
    capabilitiesValue: { capabilities: null as AiCapabilities | null },
    preferencesValue: { preferences: null as PreferencesResponse | null },
    submitReviewMock: vi.fn(),
    discardOwnPendingReviewMock: vi.fn(),
  }));

vi.mock('../src/hooks/useCapabilities', () => ({
  useCapabilities: () => ({
    capabilities: capabilitiesValue.capabilities,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: preferencesValue.preferences,
    error: null,
    refetch: () => {},
    set: () => {},
  }),
}));

// Real error types + verdict helpers kept; only the network calls are stubbed.
// discardOwnPendingReview is the one this suite drives — its result shape is the
// { ok: true } | { ok: false, code, message } discriminated union.
vi.mock('../src/api/submit', async () => {
  const actual = await vi.importActual<typeof import('../src/api/submit')>('../src/api/submit');
  return {
    ...actual,
    submitReview: (...args: unknown[]) => submitReviewMock(...args),
    discardOwnPendingReview: (...args: unknown[]) => discardOwnPendingReviewMock(...args),
    resumeForeignPendingReview: vi
      .fn()
      .mockResolvedValue({ threadCount: 0, replyCount: 0, threads: [] }),
    discardForeignPendingReview: vi.fn().mockResolvedValue(undefined),
    discardAllDrafts: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../src/api/draft', () => ({
  sendPatch: vi.fn().mockResolvedValue(undefined),
  getTabId: () => 'test-tab',
}));

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const baseProps = {
  reference: ref,
  title: 'Refactor the renewal worker',
  author: 'amelia.cho',
  activeTab: 'overview' as const,
  onTabChange: vi.fn(),
};

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

beforeEach(() => {
  capabilitiesValue.capabilities = null;
  preferencesValue.preferences = null;
  vi.clearAllMocks();
});

function renderWithToast(node: ReactNode) {
  return rtlRender(
    <AskAiDrawerProvider>
      <ToastProvider>
        {node}
        <ToastContainer />
      </ToastProvider>
    </AskAiDrawerProvider>,
  );
}

describe('PrHeader — pending-review pill (T24)', () => {
  it('renders the pill when pendingReviewId is set and the dialog is closed', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    const pill = screen.getByTestId('pending-review-pill');
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/Pending review on GitHub · Discard/);
  });

  it('does not render the pill when pendingReviewId is null', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: null })} />);
    expect(screen.queryByTestId('pending-review-pill')).not.toBeInTheDocument();
  });

  it('hides the pill while the SubmitDialog is open (even with a pendingReviewId)', () => {
    renderWithToast(
      <PrHeader
        {...baseProps}
        session={session({ pendingReviewId: 'PRR_abc', draftVerdict: 'approve' })}
      />,
    );
    // Pill visible before opening the dialog.
    expect(screen.getByTestId('pending-review-pill')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
    // SubmitDialog mounted → pill gone.
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByTestId('pending-review-pill')).not.toBeInTheDocument();
  });

  it('clicking the pill opens the discard confirmation modal', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    expect(screen.queryByTestId('discard-pending-review-modal')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('pending-review-pill'));
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
  });

  it('confirming the discard calls discardOwnPendingReview, closes the modal, and toasts on success', async () => {
    discardOwnPendingReviewMock.mockResolvedValueOnce({ ok: true });
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    fireEvent.click(screen.getByTestId('pending-review-pill'));
    fireEvent.click(screen.getByTestId('confirm-discard-pending'));

    await waitFor(() => expect(discardOwnPendingReviewMock).toHaveBeenCalledWith(ref));
    await waitFor(() =>
      expect(screen.queryByTestId('discard-pending-review-modal')).not.toBeInTheDocument(),
    );
    expect(await screen.findByText('Pending review discarded')).toBeInTheDocument();
  });

  it('shows the error in the modal on failure and strips the trailing period (no "..")', async () => {
    discardOwnPendingReviewMock.mockResolvedValueOnce({
      ok: false,
      code: 'github-network-error',
      message: 'GitHub is unreachable.',
    });
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    fireEvent.click(screen.getByTestId('pending-review-pill'));
    fireEvent.click(screen.getByTestId('confirm-discard-pending'));

    const errorRow = await screen.findByTestId('discard-pending-error');
    // Modal renders "Couldn't discard: {message}." and appends its own period —
    // the host strips the message's trailing '.' so we never render "..".
    expect(errorRow).toHaveTextContent("Couldn't discard: GitHub is unreachable.");
    expect(errorRow.textContent).not.toMatch(/\.\./);
    // Modal stays open on failure.
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
  });

  it('Cancel closes the modal without calling discardOwnPendingReview', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    fireEvent.click(screen.getByTestId('pending-review-pill'));
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByTestId('discard-pending-review-modal')).not.toBeInTheDocument();
    expect(discardOwnPendingReviewMock).not.toHaveBeenCalled();
  });
});
