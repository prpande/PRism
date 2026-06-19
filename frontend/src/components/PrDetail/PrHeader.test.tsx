import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrHeader } from './PrHeader';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import type { ReviewSessionDto } from '../../api/types';

const OPEN_SESSION: ReviewSessionDto = {
  draftVerdict: 'approve',
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

function renderHeader(extra: Partial<React.ComponentProps<typeof PrHeader>> = {}) {
  return render(
    <MemoryRouter>
      <AskAiDrawerProvider>
        <PrHeader
          reference={{ owner: 'acme', repo: 'api', number: 7 }}
          title=""
          author=""
          activeTab="overview"
          onTabChange={() => {}}
          {...extra}
        />
      </AskAiDrawerProvider>
    </MemoryRouter>,
  );
}

describe('PrHeader loading', () => {
  it('shows skeletons for title/author/chips while loading, but keeps the real breadcrumb', () => {
    renderHeader({ loading: true });
    expect(screen.getByText('acme/api')).toBeInTheDocument();
    expect(screen.getByTestId('pr-header-title-skeleton')).toBeInTheDocument();
    // Author avatar + the two CI/mergeability chip placeholders also render.
    expect(screen.getByTestId('pr-header-author-skeleton')).toBeInTheDocument();
    expect(screen.getAllByTestId('pr-header-chip-skeleton')).toHaveLength(2);
  });

  it('gives the heading an accessible name while loading (no empty <h1> for AT)', () => {
    renderHeader({ loading: true });
    // The skeleton is aria-hidden, so the sr-only label is what names the heading.
    expect(
      screen.getByRole('heading', { level: 1, name: /loading pull request/i }),
    ).toBeInTheDocument();
  });

  it('renders no action buttons or collapse toggle while loading (no clicks before load)', () => {
    renderHeader({ loading: true });
    // The Submit-review action and the header-collapse toggle are real,
    // state-dependent buttons — they must not render in the loading state.
    expect(screen.queryByRole('button', { name: /submit review/i })).toBeNull();
    expect(screen.queryByTestId('pr-header-collapse-toggle')).toBeNull();
    expect(screen.queryByRole('button', { name: /open in github/i })).toBeNull();
  });

  it('renders the real (empty) title element + the collapse toggle when not loading', () => {
    renderHeader({ loading: false, title: 'Real title' });
    expect(screen.queryByTestId('pr-header-title-skeleton')).toBeNull();
    expect(screen.getByText('Real title')).toBeInTheDocument();
    expect(screen.getByTestId('pr-header-collapse-toggle')).toBeInTheDocument();
  });
});

describe('PrHeader unified ReviewActionButton', () => {
  it('renders the unified ReviewActionButton instead of the old picker+submit cluster', () => {
    renderHeader({ session: OPEN_SESSION, prState: 'open' });
    // new split-button must be present
    expect(screen.getByTestId('review-action')).toBeInTheDocument();
    // the old VerdictPicker segmented group must be gone from the header
    expect(screen.queryByRole('group', { name: /review verdict/i })).not.toBeInTheDocument();
  });
});

describe('PrHeader mergeability chip', () => {
  it('renders the chip for a concrete mergeability state', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'mergeable' });
    const chip = container.querySelector('.chip-mergeability');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent('mergeable');
  });

  it('renders the chip for conflicting', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'conflicting' });
    const chip = container.querySelector('.chip-mergeability');
    expect(chip).not.toBeNull();
    expect(chip).toHaveTextContent('conflicting');
  });

  // GitHub returns "unknown" as its not-yet-computed / indeterminate sentinel.
  // It carries no actionable meaning, so the chip is suppressed (Truthful-by-default).
  // In production this prop only holds the uppercase GraphQL value ("UNKNOWN"); the
  // lowercase "unknown" is the REST poll's mergeable_state, which is currently dropped
  // before it reaches the frontend. We guard/test both casings defensively.
  it('hides the chip when mergeability is unknown (lowercase REST poll value)', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'unknown' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });

  it('hides the chip when mergeability is UNKNOWN (uppercase GraphQL value)', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'UNKNOWN' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });
});

describe('PrHeader refresh button', () => {
  it('renders the Refresh button in the actions cluster when not loading', () => {
    renderHeader({
      loading: false,
      onRefresh: () => {},
      isRefreshing: false,
      justRefreshed: false,
    });
    expect(screen.getByTestId('pr-refresh-button')).toBeInTheDocument();
  });

  it('does not render the Refresh button while loading', () => {
    // prActions (and the button) render only when !loading.
    renderHeader({ loading: true, onRefresh: () => {} });
    expect(screen.queryByTestId('pr-refresh-button')).not.toBeInTheDocument();
  });

  it('does not render the Refresh button when onRefresh is absent', () => {
    renderHeader({ loading: false });
    expect(screen.queryByTestId('pr-refresh-button')).not.toBeInTheDocument();
  });

  it('clicking Refresh calls onRefresh', async () => {
    const onRefresh = vi.fn();
    renderHeader({ loading: false, onRefresh, isRefreshing: false, justRefreshed: false });
    await userEvent.click(screen.getByTestId('pr-refresh-button'));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  // Spec §4.3 focus guarantee: the button is rendered in EVERY refresh state (it is not gated on
  // refresh state), so it can't be conditionally unmounted out from under keyboard focus mid-refresh.
  it.each([
    { isRefreshing: true, justRefreshed: false }, // in-flight
    { isRefreshing: false, justRefreshed: true }, // just-refreshed morph
    { isRefreshing: false, justRefreshed: false }, // idle / post-error
  ])('keeps the Refresh button mounted in refresh state %o', (state) => {
    renderHeader({ loading: false, onRefresh: () => {}, ...state });
    expect(screen.getByTestId('pr-refresh-button')).toBeInTheDocument();
  });
});

describe('PrHeader viewerReview wiring', () => {
  it('passes viewerReview to the action button and computes staleness', () => {
    renderHeader({
      prState: 'open',
      session: null,
      currentHeadSha: 'HEAD2',
      viewerReview: {
        state: 'approved',
        submittedAt: new Date().toISOString(),
        commitSha: 'HEAD1',
      },
    });
    expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/You reviewed/);
    expect(screen.getByTestId('review-action-caption')).toHaveTextContent(/out of date/);
  });
});
