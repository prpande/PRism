import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { PrDetailDto, PrReference, FileChange } from '../../api/types';
import { PrDetailView } from './PrDetailView';
import { FilesTab } from './FilesTab/FilesTab';
import { PrDetailContextProvider } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';

// ---------------------------------------------------------------------------
// PR2 Task 8 — data freshness on tab re-activation.
//
// When the user switches TO a previously-inactive keep-alive tab, the view
// must refetch its detail (usePrDetail.reload) and clear its unread dot
// (clearUnread), exactly once, on the false->true activation transition —
// never on first mount. These tests drive that wiring plus the two
// open-question guards the plan calls out:
//   OQ6 (Step 5) — a failed focus-refetch must NOT blank the kept-alive
//     content; usePrDetail keeps prior `data` and surfaces `error`, so the
//     view shows the existing content AND the error banner.
//   OQ5 (Step 6) — when a focus-refetch returns a file list that no longer
//     contains the preserved selectedPath, FilesTab's existing guard resets
//     to the first file (no crash, no orphaned selection).
//
// usePrDetail and useOpenTabs are mocked with HOISTED spies so the assertions
// can observe reload()/clearUnread() across re-renders (the PR1
// PrDetailView.test mocks usePrDetail with an inline `reload: vi.fn()` that is
// a fresh spy every render — useless for cross-render assertions).
// ---------------------------------------------------------------------------

const PR_DETAIL: PrDetailDto = {
  pr: {
    reference: { owner: 'acme', repo: 'api', number: 7 },
    title: 'Keep-alive title',
    body: 'A realistic body.',
    author: 'alice',
    state: 'open',
    headSha: 'abc123',
    baseSha: 'def456',
    headBranch: 'feat',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: '',
    isMerged: false,
    isClosed: false,
    openedAt: new Date('2026-01-01T00:00:00Z').toISOString(),
    mergedAt: null,
    closedAt: null,
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

// Hoisted spies + a mutable result holder so individual tests can reshape what
// usePrDetail returns (e.g. inject an error for the OQ6 failure case) without
// re-mocking the module.
const { reloadSpy, clearUnreadSpy, prDetailResult } = vi.hoisted(() => ({
  reloadSpy: vi.fn(),
  clearUnreadSpy: vi.fn(),
  prDetailResult: {
    current: {
      data: null as PrDetailDto | null,
      showSkeleton: false,
      error: null as Error | null,
    },
  },
}));

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: prDetailResult.current.data,
    showSkeleton: prDetailResult.current.showSkeleton,
    error: prDetailResult.current.error,
    reload: reloadSpy,
  }),
}));

// Mock the whole OpenTabsContext module so useOpenTabs() returns a full stub
// context (all 8 fields) whose clearUnread is the hoisted spy. Provide every
// field so any other consumer in the subtree (e.g. a future host hook) stays
// crash-safe. prRefKey is re-exported untouched — PrDetailView imports it from
// ../../api/types, not from here, but mocking the module would otherwise drop
// the OpenTabsProvider/useOpenTabs exports the harness might reach for.
vi.mock('../../contexts/OpenTabsContext', () => ({
  useOpenTabs: () => ({
    openTabs: [],
    unreadKeys: new Set<string>(),
    addTab: vi.fn(),
    setTitle: vi.fn(),
    closeTab: vi.fn(),
    markUnread: vi.fn(),
    clearUnread: clearUnreadSpy,
    clearAllTabs: vi.fn(),
  }),
}));

vi.mock('../../hooks/useDraftSession', () => ({
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
    clear: vi.fn(),
  }),
}));

vi.mock('../../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));

vi.mock('../../hooks/useRootCommentPostedSubscriber', () => ({
  useRootCommentPostedSubscriber: () => {},
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

// Leaf-tab data hooks fire async fetches against an absent backend. Stub them
// to benign empty results so the real OverviewTab/FilesTab render
// deterministically. useFileDiff is reshaped per-test in the OQ5 block below.
vi.mock('../../hooks/usePreferences', () => ({
  usePreferences: () => ({ preferences: null, error: null, refetch: vi.fn(), set: vi.fn() }),
}));
vi.mock('../../hooks/useCapabilities', () => ({
  useCapabilities: () => ({ capabilities: null, error: null, refetch: vi.fn() }),
}));

const { fileDiffResult } = vi.hoisted(() => ({
  fileDiffResult: {
    current: {
      data: null as { files: FileChange[]; truncated: boolean } | null,
      isLoading: false,
      showSkeleton: false,
      error: null as Error | null,
    },
  },
}));
vi.mock('../../hooks/useFileDiff', () => ({
  useFileDiff: () => fileDiffResult.current,
}));
vi.mock('../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => ({ data: null, isLoading: false, showSkeleton: false, error: null }),
}));
vi.mock('../../hooks/useAiSummary', () => ({ useAiSummary: () => null }));
vi.mock('../../hooks/useAiFileFocus', () => ({ useAiFileFocus: () => null }));
vi.mock('../../hooks/useAiDraftSuggestions', () => ({ useAiDraftSuggestions: () => null }));
vi.mock('../../hooks/useFilesTabShortcuts', () => ({ useFilesTabShortcuts: () => {} }));
vi.mock('../../hooks/useFirstActivePrPollComplete', () => ({
  useFirstActivePrPollComplete: () => true,
}));

const PR_REF: PrReference = { owner: 'acme', repo: 'api', number: 7 };

// Renders <PrDetailView> behind the provider chain and returns a rerender bound
// to the same wrappers so a test can flip `active` to drive the activation
// transition. OpenTabsProvider is intentionally omitted — useOpenTabs is mocked
// at the module level — but the rest of the provider chain (router + ask-ai +
// toast) matches the PR1 harness.
function renderPrDetailView({ active }: { active: boolean }) {
  const ui = (a: boolean) => (
    <MemoryRouter>
      <AskAiDrawerProvider>
        <ToastProvider>
          <PrDetailView prRef={PR_REF} active={a} />
        </ToastProvider>
      </AskAiDrawerProvider>
    </MemoryRouter>
  );
  const result = render(ui(active));
  return {
    ...result,
    rerender: ({ active: nextActive }: { active: boolean }) => result.rerender(ui(nextActive)),
  };
}

beforeEach(() => {
  reloadSpy.mockClear();
  clearUnreadSpy.mockClear();
  prDetailResult.current = { data: PR_DETAIL, showSkeleton: false, error: null };
  fileDiffResult.current = { data: null, isLoading: false, showSkeleton: false, error: null };
});

describe('PrDetailView — freshness on activation (Task 8)', () => {
  test('activation refetches and clears unread; first mount does not refetch', () => {
    const view = renderPrDetailView({ active: true });
    // First mount, already active: the activation transition must NOT fire.
    expect(reloadSpy).not.toHaveBeenCalled();
    // The first-mount one-shot effect DID clear unread once (Task 4 behavior).
    // Clear the spy so the next assertion isolates the RE-ACTIVATION clear.
    clearUnreadSpy.mockClear();

    view.rerender({ active: false });
    view.rerender({ active: true }); // false -> true: re-activation

    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(clearUnreadSpy).toHaveBeenCalledTimes(1);
    expect(clearUnreadSpy).toHaveBeenCalledWith('acme/api/7');
  });

  // OQ6 — a failed focus-refetch keeps the last-known data rendered and shows
  // the error banner; it must not blank the preserved view. usePrDetail's real
  // behavior on a rejected same-PR reload() is exactly this (it only clears
  // `data` on PR *navigation*), so this LOCKS that contract — no production
  // change is expected. If content were blanked, files-tab-root would be absent
  // and this test would fail.
  test('refetch failure preserves kept-alive content and shows the error banner', async () => {
    // Mount with data present so the Files sub-tab can be rendered.
    prDetailResult.current = { data: PR_DETAIL, showSkeleton: false, error: null };
    const view = renderPrDetailView({ active: true });

    // Simulate a rejected focus-refetch that kept last-known data but set error.
    prDetailResult.current = {
      data: PR_DETAIL,
      showSkeleton: false,
      error: new Error('network down'),
    };
    view.rerender({ active: true });

    // Content preserved: the Overview tab (default) still renders its root.
    expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
    // And the error banner is present with the spec copy.
    const banner = screen.getByRole('alert');
    expect(banner).toHaveTextContent(/Couldn't load PR/i);
  });
});

// ---------------------------------------------------------------------------
// OQ5 (Step 6) — stale selected-file after a focus-refetch. Focused FilesTab
// test: render FilesTab directly behind PrDetailContextProvider, drive
// useFileDiff with a mutable file list. After the list changes to one that no
// longer contains the previously-selected path, FilesTab's reset-to-first-file
// guard (the selectedPath-reset useEffect, FilesTab.tsx) must re-select the new
// first file — no crash, no orphaned selection.
//
// NOTE: shipped behavior is RESET-TO-FIRST-FILE, which diverges from spec §8
// OQ5's "empty placeholder" default. That divergence is accepted (see plan /
// PR body); this test confirms the as-built guard.
// ---------------------------------------------------------------------------
describe('FilesTab — stale selected file resets to first after refetch (OQ5)', () => {
  function file(path: string): FileChange {
    return {
      path,
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          body: '@@ -1 +1 @@\n-a\n+b\n',
        },
      ],
    };
  }

  function ctxValue(): PrDetailContextValue {
    return {
      prRef: PR_REF,
      prDetail: PR_DETAIL,
      draftSession: {
        session: { draftComments: [], draftReplies: [], draftVerdictStatus: 'none' },
        status: 'ready',
        error: null,
        refetch: vi.fn().mockResolvedValue(undefined),
        registerOpenComposer: vi.fn(() => () => {}),
        getPrRootHolder: vi.fn(() => null),
        outOfBandToast: null,
        clearOutOfBandToast: vi.fn(),
      } as unknown as PrDetailContextValue['draftSession'],
      readOnly: false,
      onSelectSubTab: vi.fn(),
    };
  }

  // Build a FRESH element on every (re)render. Re-rendering the same element
  // reference lets React bail out of reconciliation at the root, so FilesTab
  // would never re-read the (mutated) useFileDiff mock — the rerender must
  // produce a new element to force the leaf to recompute its file list.
  const ui = () => (
    <MemoryRouter>
      <AskAiDrawerProvider>
        <ToastProvider>
          <PrDetailContextProvider value={ctxValue()}>
            <FilesTab />
          </PrDetailContextProvider>
        </ToastProvider>
      </AskAiDrawerProvider>
    </MemoryRouter>
  );

  function renderFilesTab() {
    const result = render(ui());
    return { ...result, rerender: () => result.rerender(ui()) };
  }

  function selectedPathOf(): string | null {
    const rows = screen.getAllByTestId('files-tab-tree-row');
    const selected = rows.find((r) => r.getAttribute('data-selected') === 'true');
    return selected?.getAttribute('data-path') ?? null;
  }

  test('preserved selectedPath absent from the refetched list resets to first file', () => {
    // Initial list: src/a.ts (auto-selected first) + src/b.ts.
    fileDiffResult.current = {
      data: { files: [file('src/a.ts'), file('src/b.ts')], truncated: false },
      isLoading: false,
      showSkeleton: false,
      error: null,
    };
    const view = renderFilesTab();
    // The reset-to-first guard auto-selects the first file when none is chosen.
    expect(selectedPathOf()).toBe('src/a.ts');

    // Focus-refetch returns a NEW list that does not contain src/a.ts.
    fileDiffResult.current = {
      data: { files: [file('src/c.ts'), file('src/d.ts')], truncated: false },
      isLoading: false,
      showSkeleton: false,
      error: null,
    };
    view.rerender();

    // No crash; the orphaned selection resets to the new first file.
    expect(selectedPathOf()).toBe('src/c.ts');
  });
});
