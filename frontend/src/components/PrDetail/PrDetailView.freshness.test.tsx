import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { AskAiDrawerProvider } from '../../contexts/AskAiDrawerContext';
import { ToastProvider } from '../Toast/useToast';
import type { PrDetailDto, PrReference, FileChange, DiffDto } from '../../api/types';
import type { UseDraftSessionResult } from '../../hooks/useDraftSession';
import { OpenTabsContext, type OpenTabsContextValue } from '../../contexts/OpenTabsContext';
import { PrDetailView } from './PrDetailView';
import { FilesTab } from './FilesTab/FilesTab';
import { PrDetailContextProvider } from './prDetailContext';
import type { PrDetailContextValue } from './prDetailContext';
import { makePrDetailDto, makePr } from '../../../__tests__/helpers/prDetail';

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
// usePrDetail is mocked with a HOISTED spy so the assertions can observe
// reload() across re-renders (the PR1 PrDetailView.test mocks usePrDetail with
// an inline `reload: vi.fn()` that is a fresh spy every render — useless for
// cross-render assertions). clearUnread is observed via the documented
// OpenTabsContext test seam: the real useOpenTabs() hook/null-guard runs, and
// the component is rendered inside <OpenTabsContext.Provider> with a full 8-field
// stub whose clearUnread is a cross-render-stable hoisted spy.
// ---------------------------------------------------------------------------

const PR_DETAIL = makePrDetailDto({
  pr: makePr({ reference: { owner: 'acme', repo: 'api', number: 7 }, title: 'Keep-alive title' }),
});

// Hoisted spies + a mutable result holder so individual tests can reshape what
// usePrDetail returns (e.g. inject an error for the OQ6 failure case) without
// re-mocking the module.
const { reloadSpy, clearUnreadSpy, updatesClearSpy, prDetailResult, updatesResult } = vi.hoisted(
  () => ({
    reloadSpy: vi.fn(),
    clearUnreadSpy: vi.fn(),
    updatesClearSpy: vi.fn(),
    prDetailResult: {
      current: {
        data: null as PrDetailDto | null,
        isLoading: false,
        error: null as Error | null,
      },
    },
    // Mutable holder for useActivePrUpdates so a test can latch the banner
    // (hasUpdate: true) before driving the activation transition. `clear` is the
    // cross-render-stable updatesClearSpy so the focus-refetch's banner-clear
    // can be observed across re-renders (an inline vi.fn() would be a fresh spy
    // every render — useless for the assertion).
    updatesResult: {
      current: { hasUpdate: false },
    },
  }),
);

// #450 — hoisted ref capturing the single-comment-posted subscriber's onPosted.
const { singleCommentOnPosted } = vi.hoisted(() => ({
  singleCommentOnPosted: { current: null as null | (() => void) },
}));

// #743 — stub the checks hook: PrDetailView's eager check-runs prefetch would otherwise
// issue a request ~300ms after mount and land an un-act()ed state update in this file's
// previously-inert render trees.
vi.mock('../../hooks/useCheckRuns', () => ({
  useCheckRuns: () => ({
    status: 'idle' as const,
    degraded: 'none' as const,
    checks: [],
    retry: () => {},
  }),
}));

vi.mock('../../hooks/usePrDetail', () => ({
  usePrDetail: () => ({
    data: prDetailResult.current.data,
    isLoading: prDetailResult.current.isLoading,
    error: prDetailResult.current.error,
    reload: reloadSpy,
  }),
}));

// A full 8-field OpenTabsContextValue stub supplied via the documented
// OpenTabsContext test seam (see OpenTabsContext.tsx). clearUnread is the
// hoisted spy so re-activation clears can be observed across re-renders; every
// other field is a no-op spy so the real useOpenTabs() hook resolves a non-null
// context (its null-guard would otherwise throw). PrDetailView is rendered
// inside <OpenTabsContext.Provider value={openTabsStub}> below.
const openTabsStub: OpenTabsContextValue = {
  openTabs: [],
  unreadKeys: new Set<string>(),
  addTab: vi.fn(),
  setTitle: vi.fn(),
  setTabState: vi.fn(),
  closeTab: vi.fn(),
  markUnread: vi.fn(),
  clearUnread: clearUnreadSpy,
  clearAllTabs: vi.fn(),
};

vi.mock('../../hooks/useDraftSession', async (importOriginal) => ({
  // Spread the real module so pure exports (computeAnyOtherDraftsStaged,
  // called by FilesTab at render time) stay live; only the hook is faked.
  ...(await importOriginal<typeof import('../../hooks/useDraftSession')>()),
  useDraftSession: (): UseDraftSessionResult => ({
    session: {
      draftVerdict: null,
      draftVerdictStatus: 'draft',
      draftComments: [],
      draftReplies: [],
      iterationOverrides: [],
      pendingReviewId: null,
      pendingReviewCommitOid: null,
      fileViewState: { viewedFiles: {} },
    },
    status: 'ready',
    error: null,
    refetch: vi.fn().mockResolvedValue(undefined),
    registerOpenComposer: vi.fn(() => () => {}),
    getPrRootHolder: vi.fn(() => null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
    postingInProgress: false,
    beginPosting: vi.fn(),
    endPosting: vi.fn(),
    removeDraftLocally: vi.fn(),
    insertDraftLocally: vi.fn(),
  }),
}));

vi.mock('../../hooks/useActivePrUpdates', () => ({
  useActivePrUpdates: () => ({
    hasUpdate: updatesResult.current.hasUpdate,
    headShaChanged: false,
    commentCountDelta: 0,
    isMerged: false,
    isClosed: false,
    subscribed: true,
    clear: updatesClearSpy,
  }),
}));

vi.mock('../../hooks/useStateChangedSubscriber', () => ({
  useStateChangedSubscriber: () => {},
}));

vi.mock('../../hooks/useRootCommentPostedSubscriber', () => ({
  useRootCommentPostedSubscriber: () => {},
}));

// #450 — capture the single-comment-posted subscriber's onPosted so the test can fire it.
vi.mock('../../hooks/useSingleCommentPostedSubscriber', () => ({
  useSingleCommentPostedSubscriber: ({ onPosted }: { onPosted: () => void }) => {
    singleCommentOnPosted.current = onPosted;
  },
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
      data: null as DiffDto | null,
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

const PR_REF: PrReference = { owner: 'acme', repo: 'api', number: 7 };

// Renders <PrDetailView> behind the provider chain and returns a rerender bound
// to the same wrappers so a test can flip `active` to drive the activation
// transition. The full OpenTabsProvider is intentionally omitted — instead the
// component is wrapped in the documented OpenTabsContext test seam with a stub
// value (so the real useOpenTabs() hook + null-guard run). The rest of the
// provider chain (router + ask-ai + toast) matches the PR1 harness.
function renderPrDetailView({ active }: { active: boolean }) {
  const ui = (a: boolean) => (
    <MemoryRouter>
      <OpenTabsContext.Provider value={openTabsStub}>
        <AskAiDrawerProvider>
          <ToastProvider>
            <PrDetailView prRef={PR_REF} active={a} />
          </ToastProvider>
        </AskAiDrawerProvider>
      </OpenTabsContext.Provider>
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
  updatesClearSpy.mockClear();
  prDetailResult.current = { data: PR_DETAIL, isLoading: false, error: null };
  updatesResult.current = { hasUpdate: false };
  fileDiffResult.current = { data: null, isLoading: false, showSkeleton: false, error: null };
});

describe('PrDetailView — cold load shows the Overview-shaped skeleton (#181)', () => {
  test('renders the pr-detail-skeleton when data is null and isLoading is true', () => {
    // Genuine first load / PR-navigation: no data yet, fetch in flight. The
    // `!data && isLoading` gate must show the body skeleton.
    prDetailResult.current = { data: null, isLoading: true, error: null };
    renderPrDetailView({ active: true });
    expect(screen.getByTestId('pr-detail-skeleton')).toBeInTheDocument();
  });
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

  // #450 — a single inline comment/reply post emits a 'single-comment-posted' SSE
  // frame. PrDetailView subscribes (mirroring the root-comment subscriber) and its
  // onPosted fires usePrDetail.reload so the new thread surfaces with its
  // ReplyComposer — without a manual reload.
  test('a single-comment-posted event triggers usePrDetail.reload', () => {
    prDetailResult.current = { data: PR_DETAIL, isLoading: false, error: null };
    renderPrDetailView({ active: true });
    reloadSpy.mockClear();

    expect(singleCommentOnPosted.current).toBeTypeOf('function');
    singleCommentOnPosted.current!();

    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });

  // OQ8 — a backgrounded tab can latch a "PR updated" banner (useActivePrUpdates
  // hasUpdate flips true on an SSE pr-updated frame while inactive). The
  // activation callback already fires reload() to fetch fresh data, so the
  // latched banner is now a redundant, stale Reload affordance. The activation
  // path must clear it (updates.clear), exactly once on the false->true
  // transition — never on first mount.
  test('activation clears the latched update banner; first mount does not', () => {
    // Latch the banner before mounting: hasUpdate is true.
    updatesResult.current = { hasUpdate: true };
    const view = renderPrDetailView({ active: true });

    // First mount, already active: the activation transition must NOT fire, so
    // the latched banner is NOT cleared by an activation that never happened.
    expect(updatesClearSpy).not.toHaveBeenCalled();

    view.rerender({ active: false });
    view.rerender({ active: true }); // false -> true: re-activation

    // The focus-refetch supersedes the latched banner: it is cleared once. The
    // count-of-1 is implicitly scoped to the activation path — the other
    // updates.clear() call site, handleReload, is never invoked in this test (no
    // user interaction, transitionState is null), so it cannot inflate the count.
    expect(updatesClearSpy).toHaveBeenCalledTimes(1);
  });

  // OQ6 — a failed focus-refetch keeps the last-known data rendered and shows
  // the error banner; it must not blank the preserved view. usePrDetail is
  // MOCKED here, so this test does NOT lock usePrDetail's real data-preservation
  // contract (that contract is locked directly in usePrDetail.test.tsx). What it
  // locks is PrDetailView's rendering contract: GIVEN usePrDetail returns
  // { data, error } together, the view renders the existing content AND the
  // error banner. If content were blanked, overview-tab would be absent and this
  // test would fail.
  test('refetch failure preserves kept-alive content and shows the error banner', async () => {
    // Mount with data present so the Files sub-tab can be rendered.
    prDetailResult.current = { data: PR_DETAIL, isLoading: false, error: null };
    const view = renderPrDetailView({ active: true });

    // Simulate a rejected focus-refetch that kept last-known data but set error.
    prDetailResult.current = {
      data: PR_DETAIL,
      isLoading: false,
      error: new Error('network down'),
    };
    view.rerender({ active: true });

    // Content preserved: the Overview tab (default; Files is not visited in this
    // test) still renders its root.
    expect(screen.getByTestId('overview-tab')).toBeInTheDocument();
    // The load error now surfaces as the ErrorModal alertdialog (gated on
    // `active`, which is true here), distinct from the reconcile banner (a
    // separate role="alert" strip). Disambiguate by role: alertdialog = load
    // error; alert = reconcile banner. Assert the dialog carries the spec title
    // and the underlying error message.
    const dialog = screen.getByRole('alertdialog');
    expect(dialog).toHaveTextContent("Couldn't load this PR");
    expect(dialog).toHaveTextContent('network down');
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
        session: {
          draftVerdict: null,
          draftVerdictStatus: 'draft',
          draftComments: [],
          draftReplies: [],
          iterationOverrides: [],
          pendingReviewId: null,
          pendingReviewCommitOid: null,
          fileViewState: { viewedFiles: {} },
        },
        status: 'ready',
        error: null,
        refetch: vi.fn().mockResolvedValue(undefined),
        registerOpenComposer: vi.fn(() => () => {}),
        getPrRootHolder: vi.fn(() => null),
        outOfBandToast: null,
        clearOutOfBandToast: vi.fn(),
        postingInProgress: false,
        beginPosting: vi.fn(),
        endPosting: vi.fn(),
        removeDraftLocally: vi.fn(),
        insertDraftLocally: vi.fn(),
      },
      readOnly: false,
      subscribed: false,
      baseShaChanged: false,
      onSelectSubTab: vi.fn(),
      fileFocus: { status: 'no-changes', entries: [], retry: vi.fn() },
      checks: { status: 'idle', degraded: 'none', checks: [], retry: vi.fn() },
      pendingFilePath: null,
      pendingThread: null,
      requestFileView: vi.fn(),
      clearPendingFilePath: vi.fn(),
      clearPendingThread: vi.fn(),
      viewedPaths: new Set(),
      toggleViewed: vi.fn(),
      reload: vi.fn(),
      isLoading: false,
      prUpdatedSignal: 0,
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
      data: { range: 'all', files: [file('src/a.ts'), file('src/b.ts')], truncated: false },
      isLoading: false,
      showSkeleton: false,
      error: null,
    };
    const view = renderFilesTab();
    // The reset-to-first guard auto-selects the first file when none is chosen.
    expect(selectedPathOf()).toBe('src/a.ts');

    // Focus-refetch returns a NEW list that does not contain src/a.ts.
    fileDiffResult.current = {
      data: { range: 'all', files: [file('src/c.ts'), file('src/d.ts')], truncated: false },
      isLoading: false,
      showSkeleton: false,
      error: null,
    };
    view.rerender();

    // No crash; the orphaned selection resets to the new first file.
    expect(selectedPathOf()).toBe('src/c.ts');
  });
});

// ---------------------------------------------------------------------------
// #180 — returning to a kept-alive Files tab must NOT reset the selected file
// + scroll. Root cause: on re-activation, usePrDetail.reload() sets isLoading
// true while `data` is still present. A skeleton gate on `isLoading` alone
// (`isLoading ? <Skeleton/> : data ? <content/> : null`) would let the skeleton
// WIN over present data, unmounting the entire data-subtree
// (Overview/Files/Drafts). FilesTab loses its selectedPath + inner scroll and
// remounts fresh on data-return (auto-selecting the first file).
//
// The fix gates the skeleton on `!data && isLoading`: a background refresh keeps
// content mounted (the skeleton only shows on the genuine initial load, data
// still null). This test locks "isLoading + data present → kept-alive subtree
// and its selection survive". RED on main (skeleton unmounts FilesTab).
// ---------------------------------------------------------------------------
describe('PrDetailView — background reload preserves kept-alive Files state (#180)', () => {
  function file(path: string): FileChange {
    return {
      path,
      status: 'modified',
      hunks: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1 +1 @@\n-a\n+b\n' },
      ],
    };
  }

  // Top-level paths (no slash) so they render as direct tree rows — no
  // directory node to expand before the row is clickable.
  function renderFilesActive() {
    const ui = (a: boolean) => (
      <MemoryRouter>
        <OpenTabsContext.Provider value={openTabsStub}>
          <AskAiDrawerProvider>
            <ToastProvider>
              <PrDetailView prRef={PR_REF} active={a} initialSubTab="files" />
            </ToastProvider>
          </AskAiDrawerProvider>
        </OpenTabsContext.Provider>
      </MemoryRouter>
    );
    const result = render(ui(true));
    return { ...result, rerender: (a: boolean) => result.rerender(ui(a)) };
  }

  function selectedPathOf(): string | null {
    const rows = screen.getAllByTestId('files-tab-tree-row');
    const selected = rows.find((r) => r.getAttribute('data-selected') === 'true');
    return selected?.getAttribute('data-path') ?? null;
  }

  test('isLoading while data is present keeps FilesTab mounted and its selected file', async () => {
    fileDiffResult.current = {
      data: { range: 'all', files: [file('alpha.ts'), file('beta.ts')], truncated: false },
      isLoading: false,
      showSkeleton: false,
      error: null,
    };
    prDetailResult.current = { data: PR_DETAIL, isLoading: false, error: null };
    const view = renderFilesActive();

    // Files tab mounted; auto-select chose the first file. Select the second so
    // a reset-to-first regression is observable.
    expect(screen.getByTestId('files-tab-root')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('beta.ts'));
    expect(selectedPathOf()).toBe('beta.ts');

    // A same-PR background reload is in flight: data is still present, but the
    // delayed-loading skeleton has flipped on. The kept-alive subtree MUST stay
    // mounted (the keep-alive contract) — the skeleton must NOT replace present
    // data, and the user's selected file must survive.
    prDetailResult.current = { data: PR_DETAIL, isLoading: true, error: null };
    view.rerender(true);

    expect(screen.queryByTestId('files-tab-root')).toBeInTheDocument();
    expect(selectedPathOf()).toBe('beta.ts');
    // The page-level skeleton must not blank present content.
    expect(screen.queryByTestId('pr-detail-skeleton')).toBeNull();
  });
});
