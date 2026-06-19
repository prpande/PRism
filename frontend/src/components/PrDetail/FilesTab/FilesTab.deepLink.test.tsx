import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FilesTab } from './FilesTab';
import { PrDetailContextProvider } from '../prDetailContext';
import type { PrDetailContextValue } from '../prDetailContext';
import { makePrDetailDto, makePr } from '../../../../__tests__/helpers/prDetail';
import { makePrDetailContextValue } from '../testUtils';
import type { DiffDto, FileChange } from '../../../api/types';
import type { UseFileDiffResult } from '../../../hooks/useFileDiff';
import type { UseDraftSessionResult } from '../../../hooks/useDraftSession';

const BASE_SHA = 'basesha';
const HEAD_SHA = 'headsha';
const DIFF_RANGE = `${BASE_SHA}..${HEAD_SHA}`;
// A NARROWED iteration range string distinct from the full 'all' range
// (`base..head`). The full diff carries DIFF_RANGE; the narrowed iteration diff
// carries this. The deep-link readiness gate keys on the loaded diff's `range`
// matching the full range, so a settled-but-narrowed diff must NOT satisfy it.
const NARROWED_RANGE = `${BASE_SHA}..iterhead`;

const OTHER: FileChange = {
  path: 'other.cs',
  status: 'modified',
  hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1 +1 @@\n-old\n+new\n' },
  ],
};
const TARGET: FileChange = {
  path: 'target.cs',
  status: 'modified',
  hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1 +1 @@\n-x\n+y\n' }],
};

// The narrowed diff carries ONLY `other.cs`; the full diff additionally carries
// `target.cs`. The race the deep-link guards against: while the full-range diff
// re-fetch is in flight, `fileList` is still the STALE narrowed list (non-empty,
// no target). Effect 2 must NOT seize fileList[0] ('other.cs') in that window.
const NARROWED: DiffDto = { range: DIFF_RANGE, files: [OTHER], truncated: false };
const FULL: DiffDto = { range: DIFF_RANGE, files: [OTHER, TARGET], truncated: false };
// A settled diff for the NARROWED iteration range: isLoading=false (the prior
// narrowed fetch finished), data.range is the narrowed range (NOT the full
// range), and the target is absent. This is the exact stale window the
// `diff.isLoading`-only gate fails to suppress.
const NARROWED_SETTLED: DiffDto = {
  range: NARROWED_RANGE,
  files: [OTHER],
  truncated: false,
};

// Controllable per-render diff result. Every useFileDiff/useUnionDiff call reads
// this same value (FilesTab uses `rangeDiff` for the non-low-quality path).
let currentDiff: UseFileDiffResult;

vi.mock('../../../hooks/useFileDiff', () => ({
  useFileDiff: () => currentDiff,
}));
vi.mock('../../../hooks/useUnionDiff', () => ({
  useUnionDiff: () => currentDiff,
}));
vi.mock('../../../hooks/useAiHunkAnnotations', () => ({
  useAiHunkAnnotations: () => ({ state: 'empty', annotations: null }),
}));
vi.mock('../../../hooks/useWholeFileContent', () => ({
  useWholeFileContent: () => ({
    fetchStatus: 'idle',
    headContent: null,
    baseContent: null,
    failureReason: null,
  }),
}));
vi.mock('../../../api/fileViewed', () => ({
  postFileViewed: vi.fn().mockResolvedValue(undefined),
}));

function makeDraftSession(): UseDraftSessionResult {
  return {
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
    registerOpenComposer: vi.fn().mockReturnValue(() => {}),
    getPrRootHolder: vi.fn().mockReturnValue(null),
    outOfBandToast: null,
    clearOutOfBandToast: vi.fn(),
    postingInProgress: false,
    beginPosting: vi.fn(),
    endPosting: vi.fn(),
  };
}

function makeContextValue(overrides: Partial<PrDetailContextValue> = {}): PrDetailContextValue {
  return makePrDetailContextValue({
    prRef: { owner: 'octocat', repo: 'hello', number: 42 },
    prDetail: makePrDetailDto({
      pr: makePr({ headSha: HEAD_SHA, baseSha: BASE_SHA, htmlUrl: 'https://example.com/pr/42' }),
    }),
    draftSession: makeDraftSession(),
    ...overrides,
  });
}

const getRow = (path: string) =>
  screen.getAllByTestId('files-tab-tree-row').find((r) => r.getAttribute('data-path') === path);

describe('FilesTab deep-link (range-reset async race)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('lands on the target file present only in the full diff, not fileList[0]', async () => {
    const clearPendingFilePath = vi.fn();
    // 1st render: the full-range re-fetch effect (1) kicked off is STILL IN FLIGHT.
    // The headline race: `fileList` is the STALE narrowed list ('other.cs' only) —
    // NON-EMPTY, so a `fileList.length === 0` guard would NOT hold effect (2) back.
    // Because the target is absent from that stale list, a naive effect would seize
    // fileList[0] ('other.cs') and clear the intent before the full diff ever lands.
    // The `diff.isLoading` guard must suppress that.
    currentDiff = { data: NARROWED, isLoading: true, showSkeleton: false, error: null };
    const value = makeContextValue({ pendingFilePath: 'target.cs', clearPendingFilePath });

    const { rerender } = render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // While the re-fetch is in flight, effect (2) must NOT have grabbed fileList[0]
    // ('other.cs') nor cleared the intent.
    expect(getRow('other.cs')).not.toHaveAttribute('data-selected', 'true');
    expect(clearPendingFilePath).not.toHaveBeenCalled();

    // 2nd render: the full-range diff settles — the target is now present.
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    rerender(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // The target ends selected (never transiently 'other.cs'), the intent is cleared,
    // focus lands on the diff region, and the polite live region announces the path.
    await waitFor(() => {
      expect(getRow('target.cs')).toHaveAttribute('data-selected', 'true');
    });
    // NOTE: in this isolated harness clearPendingFilePath is a stub that does not
    // actually flip the context's pendingFilePath back to null, so effect (2) can
    // re-run and call it again — in production the real setter nulls it and the
    // first guard short-circuits. Assert it fired (the intent was consumed).
    expect(clearPendingFilePath).toHaveBeenCalled();

    const diffRegion = screen.getByTestId('files-tab-diff');
    expect(diffRegion).toHaveAttribute('tabindex', '-1');
    expect(document.activeElement).toBe(diffRegion);

    const live = screen.getByTestId('files-tab-live-region');
    expect(live).toHaveAttribute('aria-live', 'polite');
    expect(live).toHaveTextContent('target.cs');
  });

  it('waits for the full-range diff (not just !isLoading) when last viewed on a narrowed range', async () => {
    // Regression for the stale-isLoading race. useFileDiff only flips isLoading=true
    // inside its OWN post-commit effect, so in the render where effect (1) sets
    // activeRange='all', the loaded diff is still the SETTLED narrowed fetch:
    // isLoading=false, data.range=NARROWED_RANGE, target absent. A `!diff.isLoading`
    // gate alone would pass PREMATURELY against the stale narrowed fileList, run the
    // else-branch, and clearPendingFilePath() — stranding the user. The added
    // `diff.data?.range === allRange` gate must hold effect (2) back here.
    const clearPendingFilePath = vi.fn();
    // 1st render: narrowed fetch SETTLED (isLoading already false) but its range is
    // the narrowed range, NOT the full 'all' range. Target is absent from it.
    currentDiff = { data: NARROWED_SETTLED, isLoading: false, showSkeleton: false, error: null };
    const value = makeContextValue({ pendingFilePath: 'target.cs', clearPendingFilePath });

    const { rerender } = render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // Stale window: the loaded diff is the settled-narrowed one. Effect (2) must NOT
    // have seized fileList[0] ('other.cs') nor cleared the intent, even though
    // isLoading is already false.
    expect(getRow('other.cs')).not.toHaveAttribute('data-selected', 'true');
    expect(clearPendingFilePath).not.toHaveBeenCalled();

    // 2nd render: the in-flight full-range fetch is now marked loading (useFileDiff's
    // post-commit effect having run). Still must not consume the intent.
    currentDiff = { data: NARROWED_SETTLED, isLoading: true, showSkeleton: false, error: null };
    rerender(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );
    expect(getRow('other.cs')).not.toHaveAttribute('data-selected', 'true');
    expect(clearPendingFilePath).not.toHaveBeenCalled();

    // 3rd render: the full-range diff lands — range matches allRange, target present.
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    rerender(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    // The TARGET (only in the full diff) ends selected — never transiently 'other.cs'.
    await waitFor(() => {
      expect(getRow('target.cs')).toHaveAttribute('data-selected', 'true');
    });
    expect(clearPendingFilePath).toHaveBeenCalled();

    const live = screen.getByTestId('files-tab-live-region');
    expect(live).toHaveTextContent('target.cs');
  });

  it('falls back to the first file when the pending path is absent on the full diff', async () => {
    const clearPendingFilePath = vi.fn();
    // The full diff (settled) does NOT contain the requested path — PR changed
    // between the Hotspots fetch and the click. Effect (2) falls back to fileList[0].
    currentDiff = { data: FULL, isLoading: false, showSkeleton: false, error: null };
    const value = makeContextValue({ pendingFilePath: 'ghost.cs', clearPendingFilePath });

    render(
      <PrDetailContextProvider value={value}>
        <FilesTab />
      </PrDetailContextProvider>,
    );

    await waitFor(() => {
      expect(getRow('other.cs')).toHaveAttribute('data-selected', 'true');
    });
    expect(clearPendingFilePath).toHaveBeenCalled();
  });
});
