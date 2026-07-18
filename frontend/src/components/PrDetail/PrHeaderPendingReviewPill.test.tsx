import { render as rtlRender, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrHeader } from './PrHeader';
import { ToastProvider } from '../Toast/useToast';
import { ToastContainer } from '../Toast/ToastContainer';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import type { ReactNode } from 'react';
import type {
  AiCapabilities,
  PrReference,
  PreferencesResponse,
  ReviewSessionDto,
} from '../../api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error.
const { capabilitiesValue, preferencesValue, submitReviewMock, discardOwnPendingReviewMock } =
  vi.hoisted(() => ({
    capabilitiesValue: { capabilities: null as AiCapabilities | null },
    preferencesValue: { preferences: null as PreferencesResponse | null },
    submitReviewMock: vi.fn(),
    discardOwnPendingReviewMock: vi.fn(),
  }));

vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({
    capabilities: capabilitiesValue.capabilities,
    error: null,
    refetch: () => {},
  }),
}));
vi.mock('../../hooks/usePreferences', () => ({
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
vi.mock('../../api/submit', async () => {
  const actual = await vi.importActual<typeof import('../../api/submit')>('../../api/submit');
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

vi.mock('../../api/draft', () => ({
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

// Sessions here are pending + no verdict → main button shows "Resume review", chevron present.
function openDiscardPendingModal() {
  fireEvent.click(screen.getByTestId('review-action-chevron'));
  fireEvent.click(screen.getByRole('menuitem', { name: /discard pending review/i }));
}

describe('PrHeader — pending-review discard (T24)', () => {
  it('offers Discard pending review in the menu when pendingReviewId is set', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.getByRole('menuitem', { name: /discard pending review/i })).toBeInTheDocument();
  });

  it('no Discard pending review item when pendingReviewId is null', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: null })} />);
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    expect(
      screen.queryByRole('menuitem', { name: /discard pending review/i }),
    ).not.toBeInTheDocument();
  });

  // The dialogOpen mutual-exclusion for discard-pending is enforced in deriveMenu
  // and covered by reviewActionState.test.ts ("pending + dialogOpen → discard-pending suppressed").
  // At the integration level the chevron is frozen while the dialog is open, so the
  // menu cannot be opened — there is no clean integration expression of this invariant here.

  it('clicking "Discard pending review" in the menu opens the discard confirmation modal', () => {
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    expect(screen.queryByTestId('discard-pending-review-modal')).not.toBeInTheDocument();
    openDiscardPendingModal();
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
  });

  it('confirming the discard calls discardOwnPendingReview, closes the modal, and toasts on success', async () => {
    discardOwnPendingReviewMock.mockResolvedValueOnce({ ok: true });
    renderWithToast(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    openDiscardPendingModal();
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
    openDiscardPendingModal();
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
    openDiscardPendingModal();
    expect(screen.getByTestId('discard-pending-review-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(screen.queryByTestId('discard-pending-review-modal')).not.toBeInTheDocument();
    expect(discardOwnPendingReviewMock).not.toHaveBeenCalled();
  });
});
