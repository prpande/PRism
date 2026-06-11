import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReviewSessionDto } from '../../../api/types';
import { UnresolvedPanel } from './UnresolvedPanel';

// Regression guard for the keep-alive Task 2 pre-load crash.
//
// Task 2 moved StaleDraftRow's sub-tab CTA onto usePrDetailContext(). But
// UnresolvedPanel → StaleDraftRow is always-visible chrome: it renders during
// the pre-load window when usePrDetail's `data` is still null, which is exactly
// when PrDetailPage has NOT yet built the data-gated PrDetailContextProvider.
// useDraftSession can resolve first with stale drafts, so the panel rendered a
// StaleDraftRow OUTSIDE any provider → usePrDetailContext() threw "must be used
// inside PrDetailContextProvider" → the root ErrorBoundary tore down the app.
//
// The fix threads onSelectSubTab as an explicit prop instead of reading the
// context, so the chrome renders crash-free with no provider. These tests render
// UnresolvedPanel with NO PrDetailContextProvider — the pre-load configuration —
// to lock that in.

// Inert AI gate: UnresolvedPanel calls useAiGate + useAiDraftSuggestions, which
// reach for capabilities/preferences hooks we don't need here.
vi.mock('../../../hooks/useAiGate', () => ({
  useAiGate: () => false,
  useIsSampleMode: () => false,
}));
vi.mock('../../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => null,
}));

const PR_REF = { owner: 'acme', repo: 'api', number: 123 };

function sessionWithStaleComment(): ReviewSessionDto {
  return {
    draftVerdict: null,
    draftVerdictStatus: 'draft',
    draftComments: [
      {
        id: 'c1',
        filePath: 'src/index.ts',
        lineNumber: 10,
        side: 'right',
        anchoredSha: 'abc',
        anchoredLineContent: 'const x = 1;',
        bodyMarkdown: 'this looks stale',
        status: 'stale',
        isOverriddenStale: false,
        postedCommentId: null,
      },
    ],
    draftReplies: [],
    iterationOverrides: [],
    pendingReviewId: null,
    pendingReviewCommitOid: null,
    fileViewState: { viewedFiles: {} },
  };
}

describe('UnresolvedPanel pre-load chrome (no PrDetailContextProvider)', () => {
  it('renders a stale draft without throwing when no provider is mounted', () => {
    // Before the fix, mounting StaleDraftRow without a provider threw
    // "usePrDetailContext must be used inside PrDetailContextProvider".
    expect(() =>
      render(
        <UnresolvedPanel
          prRef={PR_REF}
          session={sessionWithStaleComment()}
          onMutated={() => {}}
          onSelectSubTab={() => {}}
        />,
      ),
    ).not.toThrow();

    expect(screen.getByTestId('unresolved-panel')).toBeInTheDocument();
    expect(screen.getByText('src/index.ts:10')).toBeInTheDocument();
  });

  it('clicking "Show me" calls the onSelectSubTab prop (file-anchored → files tab)', async () => {
    const user = userEvent.setup();
    const onSelectSubTab = vi.fn();

    render(
      <UnresolvedPanel
        prRef={PR_REF}
        session={sessionWithStaleComment()}
        onMutated={() => {}}
        onSelectSubTab={onSelectSubTab}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Show me' }));

    expect(onSelectSubTab).toHaveBeenCalledTimes(1);
    expect(onSelectSubTab).toHaveBeenCalledWith('files');
  });
});
