import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PrHeader } from './PrHeader';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ReadinessTooltipProvider } from '../shared/ReadinessTooltipContext';
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
      <ReadinessTooltipProvider>
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
      </ReadinessTooltipProvider>
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

// #593: the bare mergeability chip was replaced by the ReadinessBadge (expanded variant).
// The `mergeability` prop is kept for legacy compat (§9) but no longer drives a visible chip.
// These tests verify the prop acceptance contract; badge rendering is covered by the
// 'PrHeader readiness badge (#593)' suite below.
describe('PrHeader mergeability prop (legacy §9)', () => {
  it('accepts the mergeability prop without error (does not render a chip-mergeability chip)', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'mergeable' });
    // The old chip-mergeability is gone; no chip-mergeability class expected.
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });

  it('accepts "conflicting" mergeability without rendering a chip', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'conflicting' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });

  it('accepts "unknown" mergeability without rendering a chip', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'unknown' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });

  it('accepts "UNKNOWN" mergeability without rendering a chip', () => {
    const { container } = renderHeader({ loading: false, mergeability: 'UNKNOWN' });
    expect(container.querySelector('.chip-mergeability')).toBeNull();
  });
});

describe('PrHeader state glyph + draft marker (#501)', () => {
  it.each([
    ['open', false, 'open'],
    ['merged', false, 'merged'],
    ['closed', false, 'closed'],
    ['open', true, 'draft'],
  ] as const)(
    'renders the %s glyph (isDraft=%s) → data-pr-state=%s',
    (prState, isDraft, expected) => {
      const { container } = renderHeader({ loading: false, title: 't', prState, isDraft });
      expect(container.querySelector(`[data-pr-state="${expected}"]`)).not.toBeNull();
    },
  );

  it('shows the Draft marker for an open draft PR', () => {
    const { container } = renderHeader({
      loading: false,
      title: 't',
      prState: 'open',
      isDraft: true,
    });
    const marker = container.querySelector('.chip-info');
    expect(marker).not.toBeNull();
    expect(marker).toHaveTextContent('Draft');
  });

  it('hides the Draft marker for a non-draft open PR', () => {
    const { container } = renderHeader({
      loading: false,
      title: 't',
      prState: 'open',
      isDraft: false,
    });
    expect(container.querySelector('.chip-info')).toBeNull();
  });

  it('a merged draft shows the merged glyph and no Draft marker (precedence)', () => {
    const { container } = renderHeader({
      loading: false,
      title: 't',
      prState: 'merged',
      isDraft: true,
    });
    expect(container.querySelector('[data-pr-state="merged"]')).not.toBeNull();
    expect(container.querySelector('[data-pr-state="draft"]')).toBeNull();
    expect(container.querySelector('.chip-info')).toBeNull();
  });

  it('keeps the Draft marker as a chip-draft keeplist hook (survives collapse CSS)', () => {
    // The collapse rule hides every .prSubtitle child except the keeplist classes; the
    // marker must carry chip-draft so it isn't blanked in collapsed mode. (JSDOM doesn't
    // apply the stylesheet, so this pins the class contract that the CSS keeplist depends on
    // rather than computed visibility.)
    const { container } = renderHeader({
      loading: false,
      title: 't',
      prState: 'open',
      isDraft: true,
    });
    expect(container.querySelector('.chip-draft')).not.toBeNull();
    expect(container.querySelector('.chip-draft')).toHaveTextContent('Draft');
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

describe('PrHeader readiness badge (#593)', () => {
  it('renders the expanded readiness badge (glyph) for an open state', () => {
    const { container } = renderHeader({
      loading: false,
      mergeReadiness: 'conflicts',
      prState: 'open',
      isDraft: false,
    });
    // #593 — the badge is a bare glyph; the long reason ("Has conflicts") lives in the
    // hover popover. Assert the trigger via its accessible name + data-readiness.
    const badge = container.querySelector('[data-readiness="conflicts"]');
    expect(badge).not.toBeNull();
    expect(badge).toHaveAttribute('aria-label', 'Merge readiness: Conflicts');
  });

  it('renders NO badge for merged/closed/draft/none', () => {
    for (const props of [
      { prState: 'merged' as const, mergeReadiness: 'merged' as const },
      { prState: 'closed' as const, mergeReadiness: 'closed' as const },
      { prState: 'open' as const, isDraft: true, mergeReadiness: 'none' as const },
      { prState: 'open' as const, mergeReadiness: 'none' as const },
    ]) {
      const { container, unmount } = renderHeader({ loading: false, ...props });
      expect(container.querySelector('[data-readiness]')).toBeNull();
      unmount();
    }
  });
});
