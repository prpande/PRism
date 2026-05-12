import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrHeader } from '../src/components/PrDetail/PrHeader';
import type {
  AiCapabilities,
  PrReference,
  ReviewSessionDto,
  UiPreferences,
} from '../src/api/types';

// vi.hoisted so the mock factories (themselves hoisted above the imports) can
// read these mutable containers without a TDZ error.
const { capabilitiesValue, preferencesValue } = vi.hoisted(() => ({
  capabilitiesValue: { capabilities: null as AiCapabilities | null },
  preferencesValue: { preferences: null as UiPreferences | null },
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
