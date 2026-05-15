import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrHeader } from '../src/components/PrDetail/PrHeader';
import { ToastProvider } from '../src/components/Toast/useToast';
import { ToastContainer } from '../src/components/Toast/ToastContainer';
import { SubmitConflictError } from '../src/api/submit';
import type { ReactNode } from 'react';
import type {
  AiCapabilities,
  PrReference,
  ReviewSessionDto,
  UiPreferences,
} from '../src/api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error.
const { capabilitiesValue, preferencesValue, submitReviewMock } = vi.hoisted(() => ({
  capabilitiesValue: { capabilities: null as AiCapabilities | null },
  preferencesValue: { preferences: null as UiPreferences | null },
  submitReviewMock: vi.fn(),
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

// Real SubmitConflictError + verdictToSubmitWire kept; only the network call is
// stubbed so the catch in PrHeader runs against a real thrown error type.
vi.mock('../src/api/submit', async () => {
  const actual = await vi.importActual<typeof import('../src/api/submit')>('../src/api/submit');
  return {
    ...actual,
    submitReview: (...args: unknown[]) => submitReviewMock(...args),
    resumeForeignPendingReview: vi.fn().mockResolvedValue({ threadCount: 0, replyCount: 0, threads: [] }),
    discardForeignPendingReview: vi.fn().mockResolvedValue(undefined),
    discardAllDrafts: vi.fn().mockResolvedValue(undefined),
  };
});

// Drains the PUT /draft summary-flush + any other fire-and-forget calls fired
// from SubmitDialog.handleConfirm so they don't error in tests.
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

const readySession = session({ draftVerdict: 'approve' });

beforeEach(() => {
  capabilitiesValue.capabilities = null;
  preferencesValue.preferences = null;
  vi.clearAllMocks();
});

// Wraps the SUT in a real ToastProvider + ToastContainer so tests can assert
// on the rendered toast nodes after PrHeader's catch handlers fire `show`.
function renderWithToast(node: ReactNode) {
  return render(
    <ToastProvider>
      {node}
      <ToastContainer />
    </ToastProvider>,
  );
}

describe('PrHeader', () => {
  it('renders the PR title', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText('Refactor the renewal worker')).toBeInTheDocument();
  });

  it('renders repo and number from the reference', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText(/octocat\/hello/i)).toBeInTheDocument();
    expect(screen.getByText(/#42/i)).toBeInTheDocument();
  });

  it('renders the author', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByText(/amelia\.cho/i)).toBeInTheDocument();
  });

  it('renders branch info when provided', () => {
    render(
      <PrHeader {...baseProps} branchInfo={{ headBranch: 'amelia/work', baseBranch: 'main' }} />,
    );
    expect(screen.getByText(/amelia\/work/i)).toBeInTheDocument();
    expect(screen.getByText(/main/i)).toBeInTheDocument();
  });

  it('renders mergeability chip when provided', () => {
    render(<PrHeader {...baseProps} mergeability="mergeable" />);
    expect(screen.getByText(/mergeable/i)).toBeInTheDocument();
  });

  it('renders CI chip when ciSummary provided', () => {
    render(<PrHeader {...baseProps} ciSummary="success" />);
    expect(screen.getByText(/success/i)).toBeInTheDocument();
  });

  it('Submit button is disabled while the draft session is still loading (no session)', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
  });

  it('Submit button is enabled once a submittable session is supplied', () => {
    render(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    expect(screen.getByRole('button', { name: /submit review/i })).toBeEnabled();
  });

  it('Submit button stays disabled when head_sha drift is reported (rule f)', () => {
    render(<PrHeader {...baseProps} session={readySession} headShaDrift />);
    expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
  });

  it('renders the verdict picker bound to the session verdict', () => {
    render(<PrHeader {...baseProps} session={session({ draftVerdict: 'approve' })} />);
    const group = screen.getByRole('group', { name: /verdict/i });
    expect(group).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('clicking Submit Review opens the dialog', () => {
    render(<PrHeader {...baseProps} session={readySession} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the in-flight-submit recovery badge when the session carries a pendingReviewId', () => {
    render(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    expect(screen.getByRole('button', { name: /submit in progress.*resume/i })).toBeInTheDocument();
  });

  it('does not render the Ask AI button unless aiPreview is on', () => {
    render(<PrHeader {...baseProps} session={readySession} />);
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });

  it('renders the Ask AI button + opens the empty-state container when aiPreview is on', () => {
    preferencesValue.preferences = { theme: 'system', accent: 'indigo', aiPreview: true };
    render(<PrHeader {...baseProps} session={readySession} />);
    const askAi = screen.getByRole('button', { name: /ask ai/i });
    expect(askAi).toBeInTheDocument();
    expect(screen.queryByText(/coming in v2/i)).not.toBeInTheDocument();
    fireEvent.click(askAi);
    expect(screen.getByText(/coming in v2/i)).toBeInTheDocument();
  });

  it('does not render the branch arrow when branchInfo is absent and the dialog is closed', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.queryByText(/→/)).not.toBeInTheDocument();
  });

  it('renders the PrSubTabStrip with the activeTab prop', () => {
    render(<PrHeader {...baseProps} activeTab="files" />);
    const filesTab = screen.getByRole('tab', { name: /files/i });
    expect(filesTab).toHaveAttribute('aria-selected', 'true');
  });

  it('renders the PrSubTabStrip with fileCount when provided', () => {
    render(<PrHeader {...baseProps} fileCount={5} />);
    const filesTab = screen.getByRole('tab', { name: /files/i });
    expect(filesTab.textContent).toMatch(/5/);
  });
});

describe('PrHeader — surfacing 4xx errors from /submit (regression: silent swallow)', () => {
  // Root cause from production debugging: PrHeader.tsx's onSubmit catch was
  // empty with a comment claiming useSubmitToasts handled the toast — but
  // useSubmitToasts only listens for two SSE events, NOT HTTP errors. Result:
  // every 4xx from /submit (head-sha-drift, unauthorized, no-session, ...)
  // produced an in-flight "flash" with no user feedback. These tests assert
  // each known SubmitConflictError code surfaces a useful toast.

  async function clickSubmitAndConfirm() {
    fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
    const confirm = await screen.findByRole('button', { name: /confirm submit/i });
    fireEvent.click(confirm);
  }

  it('surfaces head-sha-drift as an error toast naming the Reload remedy', async () => {
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('head-sha-drift', 'Reload the PR before submitting.'),
    );
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    expect(await screen.findByText(/head commit changed.*reload the PR/i)).toBeInTheDocument();
  });

  it('surfaces head-sha-not-stamped with a server-side wire-up phrasing', async () => {
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError(
        'head-sha-not-stamped',
        'PR detail has not been marked viewed yet — reload the PR.',
      ),
    );
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    expect(await screen.findByText(/PR view hasn't been stamped yet/i)).toBeInTheDocument();
  });

  it('surfaces unauthorized as an error toast naming subscription loss', async () => {
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('unauthorized', 'Subscribe to this PR before submitting.'),
    );
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    expect(await screen.findByText(/subscription to this PR was lost/i)).toBeInTheDocument();
  });

  it('surfaces stale-drafts as an error toast pointing at the Drafts tab', async () => {
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('stale-drafts', 'Resolve stale drafts before submitting.'),
    );
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    expect(await screen.findByText(/stale drafts.*Drafts tab/i)).toBeInTheDocument();
  });

  it('falls through to the server-supplied message on an unknown SubmitConflictError code', async () => {
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('something-new-from-future-spec', 'New thing.'),
    );
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    // Server-supplied message reaches the user even for codes the FE doesn't
    // know about, so a future backend code is at least visible, not silent.
    expect(await screen.findByText(/new thing/i)).toBeInTheDocument();
  });

  it('surfaces a generic error toast when submit throws a non-SubmitConflictError', async () => {
    submitReviewMock.mockRejectedValueOnce(new Error('network down'));
    renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
    await clickSubmitAndConfirm();
    expect(await screen.findByText(/unexpected error.*Try again/i)).toBeInTheDocument();
  });
});

describe('PrHeader — closed/merged PR (PR5 § 13)', () => {
  it('shows "Discard all drafts", hides the verdict picker, and disables Submit on a closed PR with session content', () => {
    render(
      <PrHeader
        {...baseProps}
        session={session({ pendingReviewId: 'PRR_x', draftVerdict: 'approve' })}
        prState="closed"
      />,
    );
    expect(screen.getByRole('button', { name: /discard all drafts/i })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /verdict/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit review/i })).toBeDisabled();
  });

  it('does not show "Discard all drafts" on a closed PR with an empty session', () => {
    render(<PrHeader {...baseProps} session={session()} prState="closed" />);
    expect(screen.queryByRole('button', { name: /discard all drafts/i })).not.toBeInTheDocument();
  });

  it('does not show "Discard all drafts" on an open PR even with session content; verdict picker stays', () => {
    render(
      <PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_x' })} prState="open" />,
    );
    expect(screen.queryByRole('button', { name: /discard all drafts/i })).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: /verdict/i })).toBeInTheDocument();
  });

  it('clicking "Discard all drafts" opens the confirmation modal naming what is removed', () => {
    render(
      <PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_x' })} prState="merged" />,
    );
    fireEvent.click(screen.getByRole('button', { name: /discard all drafts/i }));
    expect(screen.getByText(/on this merged PR/i)).toBeInTheDocument();
    expect(screen.getByText(/pending review on github/i)).toBeInTheDocument();
    expect(screen.getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});
