import { render as rtlRender, screen, fireEvent, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PrHeader } from './PrHeader';
import { ToastProvider } from '../Toast/useToast';
import { ToastContainer } from '../Toast/ToastContainer';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { SubmitConflictError } from '../../api/submit';
import type { ReactNode } from 'react';
import type {
  AiCapabilities,
  PrReference,
  PreferencesResponse,
  ReviewSessionDto,
} from '../../api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error.
const { capabilitiesValue, preferencesValue, submitReviewMock } = vi.hoisted(() => ({
  capabilitiesValue: { capabilities: null as AiCapabilities | null },
  preferencesValue: { preferences: null as PreferencesResponse | null },
  submitReviewMock: vi.fn(),
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

// Real SubmitConflictError kept; only the network call is stubbed so the catch
// in PrHeader runs against a real thrown error type.
vi.mock('../../api/submit', async () => {
  const actual = await vi.importActual<typeof import('../../api/submit')>('../../api/submit');
  return {
    ...actual,
    submitReview: (...args: unknown[]) => submitReviewMock(...args),
    resumeForeignPendingReview: vi
      .fn()
      .mockResolvedValue({ threadCount: 0, replyCount: 0, threads: [] }),
    discardForeignPendingReview: vi.fn().mockResolvedValue(undefined),
    discardAllDrafts: vi.fn().mockResolvedValue(undefined),
  };
});

// Drains the PUT /draft summary-flush + any other fire-and-forget calls fired
// from SubmitDialog.handleConfirm so they don't error in tests.
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

const readySession = session({ draftVerdict: 'approve' });

beforeEach(() => {
  capabilitiesValue.capabilities = null;
  preferencesValue.preferences = null;
  vi.clearAllMocks();
});

// PrHeader tests render inside AskAiDrawerProvider so any descendant that
// consumes useAskAiDrawer() has its context (the hook throws if rendered
// outside the provider). `render` is shadowed so existing tests don't need
// per-call updates.
function render(node: ReactNode) {
  return rtlRender(<AskAiDrawerProvider>{node}</AskAiDrawerProvider>);
}

// Wraps the SUT in a real ToastProvider + ToastContainer so tests can assert
// on the rendered toast nodes after PrHeader's catch handlers fire `show`.
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

  // #593: mergeability chip replaced by ReadinessBadge; mergeability prop is kept for §9 compat
  // but no longer renders a visible chip. The readiness badge is tested in PrHeader.test.tsx.
  it('accepts mergeability prop without rendering a chip (replaced by readiness badge in #593)', () => {
    const { container } = render(<PrHeader {...baseProps} mergeability="mergeable" />);
    expect(container.querySelector('.chip-mergeability')).toBeNull();
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
    expect(screen.getByTestId('review-action-main')).toBeEnabled();
  });

  it('Submit button stays disabled when head_sha drift is reported (rule f)', () => {
    render(<PrHeader {...baseProps} session={readySession} headShaDrift />);
    expect(screen.getByTestId('review-action-main')).toBeDisabled();
  });

  it('reflects the session verdict on the action button', () => {
    render(<PrHeader {...baseProps} session={session({ draftVerdict: 'approve' })} />);
    // The main button label reflects the active verdict.
    expect(screen.getByTestId('review-action-main')).toHaveTextContent('Approve');
    // Opening the menu exposes all three verdict options; the checked one carries a ✓.
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.getByRole('menuitem', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Request changes' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Comment' })).toBeInTheDocument();
    expect(
      within(screen.getByRole('menuitem', { name: 'Approve' })).getByText('✓'),
    ).toBeInTheDocument();
  });

  it('clicking Submit Review opens the dialog', () => {
    render(<PrHeader {...baseProps} session={readySession} />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('review-action-main'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('surfaces a resumable pending review on the action button', () => {
    render(<PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_abc' })} />);
    const main = screen.getByTestId('review-action-main');
    expect(main).toHaveTextContent('Resume review');
    expect(main).toHaveAttribute('title', expect.stringMatching(/pending review on github/i));
  });

  it('does not render the Ask AI button unless aiPreview is on', () => {
    render(<PrHeader {...baseProps} session={readySession} />);
    expect(screen.queryByRole('button', { name: /ask ai/i })).not.toBeInTheDocument();
  });

  // The Ask-AI trigger moved to the App-level AskAiPullTab (outside PrHeader).
  // Integration coverage for the pull-tab toggle lives in AskAiPullTab.test.tsx.

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

describe('#131 Open in GitHub button', () => {
  it('renders the button when htmlUrl is present', () => {
    render(<PrHeader {...baseProps} htmlUrl="https://github.example.com/octocat/hello/pull/42" />);
    const link = screen.getByTestId('open-in-github-button');
    expect(link).toHaveAttribute('href', 'https://github.example.com/octocat/hello/pull/42');
  });

  it('renders nothing for the button when htmlUrl is absent', () => {
    render(<PrHeader {...baseProps} />);
    expect(screen.queryByTestId('open-in-github-button')).toBeNull();
  });

  it('dev-warns when a loaded PR (title present) has no htmlUrl', () => {
    // The warn is the spec-named (D2) regression signal: a loaded PR with no
    // htmlUrl silently drops all three escape-hatch links. Assert it fires so a
    // future removal of the useEffect is caught.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<PrHeader {...baseProps} />);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Open-in-GitHub links hidden'),
      expect.anything(),
    );
    warn.mockRestore();
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
    fireEvent.click(screen.getByTestId('review-action-main'));
    const confirm = await screen.findByRole('button', { name: /confirm submit/i });
    fireEvent.click(confirm);
  }

  // Every known SubmitConflictError code → expected toast substring (regex).
  // The list mirrors KNOWN_SUBMIT_ERROR_CODES in frontend/src/api/submit.ts;
  // when a code is added there, add a row here so the per-code toast copy is
  // covered. Each row exists because pre-fix the catch was empty and produced
  // no toast at all — covering every arm prevents a copy-paste regression in
  // submitErrorMessage from shipping invisibly.
  const codeToastCases: ReadonlyArray<readonly [string, RegExp]> = [
    ['head-sha-drift', /head commit changed.*reload the PR/i],
    ['head-sha-not-stamped', /PR view hasn't been stamped yet/i],
    ['unauthorized', /subscription to this PR was lost/i],
    ['no-session', /no draft session for this PR/i],
    ['stale-drafts', /stale drafts.*Drafts tab/i],
    ['verdict-needs-reconfirm', /re-confirm your verdict/i],
    ['no-content', /Comment-verdict review needs at least one/i],
    ['verdict-invalid', /verdict must be Approve, Request changes, or Comment/i],
    ['submit-in-progress', /A submit is already in flight/i],
  ];

  it.each(codeToastCases)(
    'surfaces SubmitConflictError(%s) via a per-code toast',
    async (code, expected) => {
      submitReviewMock.mockRejectedValueOnce(new SubmitConflictError(code, 'server-supplied'));
      renderWithToast(<PrHeader {...baseProps} session={readySession} headShaDrift={false} />);
      await clickSubmitAndConfirm();
      expect(await screen.findByText(expected)).toBeInTheDocument();
    },
  );

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

  it('surfaces 4xx via toast on the Resume path (parallel onResume catch)', async () => {
    // Regression: PR #55 wired surfaceSubmitError into onSubmit but the parallel
    // onResume path sat untested. The recovery flow is the higher-stakes silent-
    // failure surface — the user already failed once. Asserts the catch wires
    // through surfaceSubmitError, not the empty .catch(() => {}) that shipped
    // originally on the dialog onSubmit.
    // With pending+approve the main button action is resume → fires onResume → catch surfaces toast.
    submitReviewMock.mockRejectedValueOnce(
      new SubmitConflictError('submit-in-progress', 'A submit is already in flight.'),
    );
    renderWithToast(
      <PrHeader
        {...baseProps}
        session={session({ pendingReviewId: 'PRR_recover', draftVerdict: 'approve' })}
      />,
    );
    fireEvent.click(screen.getByTestId('review-action-main'));
    expect(await screen.findByText(/A submit is already in flight/i)).toBeInTheDocument();
  });
});

describe('PrHeader — closed/merged PR (PR5 § 13)', () => {
  it('shows "Discard all drafts" in the menu, hides the verdict picker, and shows Drafts label on a closed PR with session content', () => {
    render(
      <PrHeader
        {...baseProps}
        session={session({ pendingReviewId: 'PRR_x', draftVerdict: 'approve' })}
        prState="closed"
      />,
    );
    // Main button shows "Drafts" for closed/merged PRs.
    expect(screen.getByTestId('review-action-main')).toHaveTextContent('Drafts');
    // No standalone verdict group — verdict is surfaced in the menu, not a picker widget.
    expect(screen.queryByRole('group', { name: /verdict/i })).not.toBeInTheDocument();
    // Discard all drafts is offered in the menu.
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.getByRole('menuitem', { name: /discard all drafts/i })).toBeInTheDocument();
    // No submit item in the menu for closed/merged PRs.
    expect(screen.queryByRole('menuitem', { name: /submit/i })).not.toBeInTheDocument();
  });

  it('does not show "Discard all drafts" on a closed PR with an empty session', () => {
    render(<PrHeader {...baseProps} session={session()} prState="closed" />);
    // Menu is empty (no drafts) — the chevron opens nothing (or closes immediately).
    // Either way, no discard-all menuitem should be present.
    expect(screen.queryByRole('menuitem', { name: /discard all drafts/i })).not.toBeInTheDocument();
  });

  it('does not show "Discard all drafts" on an open PR even with session content; verdict options stay in the menu', () => {
    render(
      <PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_x' })} prState="open" />,
    );
    // No discard-all in the menu for open PRs.
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    expect(screen.queryByRole('menuitem', { name: /discard all drafts/i })).not.toBeInTheDocument();
    // Verdict options ARE available in the menu (replaces the old verdict-picker group).
    expect(screen.getByRole('menuitem', { name: 'Approve' })).toBeInTheDocument();
  });

  it('clicking "Discard all drafts" from the menu opens the confirmation modal naming what is removed', () => {
    render(
      <PrHeader {...baseProps} session={session({ pendingReviewId: 'PRR_x' })} prState="merged" />,
    );
    fireEvent.click(screen.getByTestId('review-action-chevron'));
    fireEvent.click(screen.getByRole('menuitem', { name: /discard all drafts/i }));
    // Scope assertions to the confirmation dialog.
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/on this merged PR/i)).toBeInTheDocument();
    expect(dialog.getByText(/pending review on github/i)).toBeInTheDocument();
    expect(dialog.getByText(/cannot be undone/i)).toBeInTheDocument();
  });
});

describe('PrHeader — merged/closed status label (Task 13)', () => {
  // Fixed "now": 2024-02-01T00:00:00Z
  // mergedAt:    2024-01-01T00:00:00Z  → 31 days before now → "Merged 31d ago"
  // closedAt:    2024-01-15T00:00:00Z  → 17 days before now → "Closed 17d ago"
  const FIXED_NOW = new Date('2024-02-01T00:00:00Z');
  const MERGED_AT = '2024-01-01T00:00:00Z';
  const CLOSED_AT = '2024-01-15T00:00:00Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the full "Merged Nd ago" label including the age fragment on a merged PR', () => {
    render(<PrHeader {...baseProps} prState="merged" mergedAt={MERGED_AT} />);
    expect(screen.getByText('Merged 31d ago')).toBeInTheDocument();
  });

  it('shows the full "Closed Nd ago" label including the age fragment on a closed-unmerged PR', () => {
    render(<PrHeader {...baseProps} prState="closed" closedAt={CLOSED_AT} />);
    expect(screen.getByText('Closed 17d ago')).toBeInTheDocument();
  });

  it('does not show a Merged label when mergedAt is absent', () => {
    render(<PrHeader {...baseProps} prState="merged" />);
    expect(screen.queryByText(/Merged/)).not.toBeInTheDocument();
  });

  it('does not show a Closed label when closedAt is absent', () => {
    render(<PrHeader {...baseProps} prState="closed" />);
    expect(screen.queryByText(/Closed/)).not.toBeInTheDocument();
  });

  it('does not show a status label on an open PR', () => {
    render(<PrHeader {...baseProps} prState="open" mergedAt={MERGED_AT} closedAt={CLOSED_AT} />);
    expect(screen.queryByText(/Merged/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Closed/)).not.toBeInTheDocument();
  });
});
