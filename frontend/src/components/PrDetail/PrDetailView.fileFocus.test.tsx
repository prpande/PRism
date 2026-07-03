import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { OpenTabsProvider } from '../../contexts/OpenTabsContext';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { AiCapabilities } from '../../api/types';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';
import type { PrTabId } from './PrSubTabStrip';
import { PrDetailView } from './PrDetailView';

// ---------------------------------------------------------------------------
// Spec §8 — Hotspots tab visibility is gated on the fileFocus capability. When
// AI is Off the tab is removed from the DOM (not display:none) and no Hotspots
// content mounts; a /hotspots deep-link landed while Off falls back to Overview
// (not the misleading "No file changes to review." Hotspots state). When the
// capability is on (Preview), the tab appears.
//
// `useCapabilities` / `usePreferences` are mutable here so each test can flip
// fileFocus on/off; the rest mirror PrDetailView.test.tsx's benign stubs.
// ---------------------------------------------------------------------------

// Mirrors useCapabilities' ALL_OFF / LIVE_CAPABILITIES shape; only fileFocus
// matters to the gating under test, but the full record keeps the type honest.
const ALL_OFF: AiCapabilities = {
  summary: false,
  fileFocus: false,
  hunkAnnotations: false,
  preSubmitValidators: false,
  composerAssist: false,
  draftSuggestions: false,
  draftReconciliation: false,
  inboxEnrichment: false,
  inboxRanking: false,
};
const FILE_FOCUS_ON: AiCapabilities = { ...ALL_OFF, fileFocus: true };

let capabilities: AiCapabilities | null = null;
let aiMode: 'off' | 'preview' | 'live' = 'off';

const PR_DETAIL = makePrDetailDto({
  pr: makePr({
    reference: { owner: 'acme', repo: 'api', number: 7 },
    title: 'File-focus gating title',
    author: 'alice',
  }),
});

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({ data: PR_DETAIL, isLoading: false, error: null, reload: vi.fn() }),
}));
vi.mock('../../hooks/useDraftSession', async (importOriginal) => ({
  // Spread the real module so pure exports (computeAnyOtherDraftsStaged,
  // called by FilesTab at render time) stay live; only the hook is faked.
  ...(await importOriginal<typeof import('../../hooks/useDraftSession')>()),
  useDraftSession: () => ({
    session: { draftComments: [], draftReplies: [], draftVerdictStatus: 'none' },
    status: 'ready',
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    registerOpenComposer: vi.fn(() => () => {}),
    getPrRootHolder: vi.fn(() => null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
  }),
}));
vi.mock('../../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({
    hasUpdate: false,
    headShaChanged: false,
    commentCountDelta: 0,
    isMerged: false,
    isClosed: false,
    subscribed: true,
    clear: vi.fn(),
  }),
}));
vi.mock('../../hooks/useStateChangedSubscriber', () => ({ useStateChangedSubscriber: () => {} }));
vi.mock('../../hooks/useRootCommentPostedSubscriber', () => ({
  useRootCommentPostedSubscriber: () => {},
}));
vi.mock('../../hooks/useSingleCommentPostedSubscriber', () => ({
  useSingleCommentPostedSubscriber: () => {},
}));
vi.mock('../../hooks/useDraftSubmittedSubscriber', () => ({
  useDraftSubmittedSubscriber: () => {},
}));
vi.mock('../../hooks/useCrossTabPrPresence', () => ({
  useCrossTabPrPresence: () => ({
    readOnly: false,
    showBanner: false,
    switchToOther: vi.fn(),
    takeOver: vi.fn(),
    dismissForSession: vi.fn(),
  }),
}));
vi.mock('../../hooks/useReconcile', () => ({
  useReconcile: () => ({
    reload: vi.fn().mockResolvedValue(undefined),
    banner: null,
    clearBanner: vi.fn(),
  }),
}));

vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { ui: { aiMode } },
    error: null,
    refetch: vi.fn(),
    set: vi.fn(),
  }),
}));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities, error: null, refetch: vi.fn() }),
}));

// The single shared file-focus fetch is owned by PrDetailView; mock it so no
// network fires. When the capability is on we return the 'no-changes' state —
// the same state the real hook yields when disabled — to prove that even that
// "No file changes to review." Hotspots content NEVER mounts while AI is Off
// (it is gated on the capability, not just on the fetch result).
vi.mock('../../hooks/useFileFocusResult', () => ({
  useFileFocusResult: () => ({ status: 'no-changes', entries: [], retry: vi.fn() }),
}));

// Leaf-tab data hooks fire async fetches against an absent backend — stub benign.
vi.mock('../../hooks/useFileDiff', () => ({
  useFileDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useAiSummary', () => ({
  useAiSummary: () => ({ summary: null, loading: false, error: false }),
}));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({
  useAiDraftSuggestions: () => ({ state: 'empty', suggestions: null }),
}));
vi.mock('../../hooks/useFilesTabShortcuts', () => ({ useFilesTabShortcuts: () => {} }));
vi.mock('../../hooks/useFirstActivePrPollComplete', () => ({
  useFirstActivePrPollComplete: () => true,
}));

function renderView(initialSubTab?: PrTabId) {
  return render(
    <MemoryRouter>
      <OpenTabsProvider>
        <AskAiDrawerProvider>
          <ToastProvider>
            <PrDetailView
              prRef={{ owner: 'acme', repo: 'api', number: 7 }}
              active
              initialSubTab={initialSubTab}
            />
          </ToastProvider>
        </AskAiDrawerProvider>
      </OpenTabsProvider>
    </MemoryRouter>,
  );
}

describe('PrDetailView — Hotspots tab gated on fileFocus capability (spec §8)', () => {
  beforeEach(() => {
    capabilities = null;
    aiMode = 'off';
  });

  test('AI Off: no Hotspots tab and no Hotspots content', () => {
    renderView();
    expect(screen.queryByRole('tab', { name: /hotspots/i })).not.toBeInTheDocument();
    // No HotspotsTab content mounts (its "No file changes" message must not leak).
    expect(screen.queryByText(/no file changes to review/i)).not.toBeInTheDocument();
  });

  test('AI Off + /hotspots deep-link: renders Overview, not the Hotspots state', () => {
    renderView('hotspots');
    // The misleading Hotspots "No file changes to review." content must not show.
    expect(screen.queryByText(/no file changes to review/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /hotspots/i })).not.toBeInTheDocument();
    // Falls back to Overview (the safe default), not a blank screen.
    expect(screen.getByTestId('overview-tab')).toBeVisible();
    // Overview is the active tab in the strip.
    expect(screen.getByRole('tab', { name: /overview/i })).toHaveAttribute('aria-selected', 'true');
  });

  test('Preview (fileFocus on): the Hotspots tab appears', () => {
    capabilities = FILE_FOCUS_ON;
    aiMode = 'preview';
    renderView();
    expect(screen.getByRole('tab', { name: /hotspots/i })).toBeInTheDocument();
  });

  test('Preview + /hotspots deep-link: the Hotspots tab is active', () => {
    capabilities = FILE_FOCUS_ON;
    aiMode = 'preview';
    renderView('hotspots');
    expect(screen.getByRole('tab', { name: /hotspots/i })).toHaveAttribute('aria-selected', 'true');
  });
});
