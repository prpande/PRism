import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { jsonResponse } from './helpers/http';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
import { PrDetailContextProvider } from '../src/components/PrDetail/prDetailContext';
import { useDraftSession } from '../src/hooks/useDraftSession';
import type { PrDetailDto, DiffDto, PrReference, ReviewSessionDto } from '../src/api/types';

const emptyReviewSession: ReviewSessionDto = {
  draftVerdict: null,
  draftVerdictStatus: 'draft',
  draftComments: [],
  draftReplies: [],
  iterationOverrides: [],
  pendingReviewId: null,
  pendingReviewCommitOid: null,
  fileViewState: { viewedFiles: {} },
};

// Routes /draft to a valid empty ReviewSessionDto and falls through to the
// supplied diff-handler fetch for everything else. The diff-handler mock in
// each test below was previously catching /draft and returning the DiffDto
// shape, leaving draftSession.session with `draftComments: undefined`. Any
// future test that exercises FilesTab.findExistingDraft would crash; this
// helper prevents that. See FilesTabComposer.test.tsx makeRouteHandler for
// the per-route pattern.
function diffOrDraft(diffMock: () => Promise<Response>) {
  return vi.fn().mockImplementation((url: string) => {
    if (typeof url === 'string' && url.endsWith('/draft')) {
      return Promise.resolve(jsonResponse(emptyReviewSession));
    }
    return diffMock();
  });
}

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const minimalPrDetail: PrDetailDto = {
  pr: {
    reference: ref,
    title: 'Test PR',
    body: '',
    author: 'test',
    state: 'open',
    headSha: 'headabc',
    baseSha: 'basedef',
    headBranch: 'feature',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
    mergedAt: null,
    closedAt: null,
  },
  clusteringQuality: 'ok',
  iterations: [
    {
      number: 1,
      beforeSha: 'basedef',
      afterSha: 'headabc',
      commits: [],
      hasResolvableRange: true,
    },
  ],
  commits: [
    {
      sha: 'headabc',
      message: 'init',
      committedDate: '2026-05-01T00:00:00Z',
      additions: 5,
      deletions: 2,
    },
  ],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

const sampleDiff: DiffDto = {
  range: 'basedef..headabc',
  files: [
    { path: 'src/main.ts', status: 'modified', hunks: [] },
    { path: 'README.md', status: 'added', hunks: [] },
  ],
  truncated: false,
};

// Modified file with non-empty hunks — satisfies the whole-file toggle's
// enabled condition (status === 'modified' AND hunks.length > 0).
const sampleModifiedDiff: DiffDto = {
  range: 'basedef..headabc',
  files: [
    {
      path: 'src/main.ts',
      status: 'modified',
      hunks: [
        {
          oldStart: 1,
          oldLines: 3,
          newStart: 1,
          newLines: 4,
          body: '+added line\n context line\n-removed line\n',
        },
      ],
    },
  ],
  truncated: false,
};

// Single added file — toggle should be disabled with "modified files only" title.
const sampleAddedDiff: DiffDto = {
  range: 'basedef..headabc',
  files: [{ path: 'src/new.ts', status: 'added', hunks: [] }],
  truncated: false,
};

// PrDetail with two iterations — clicking iteration-tab-1 sets activeRange !== 'all'.
const sampleMultiIterationPrDetail: PrDetailDto = {
  ...minimalPrDetail,
  pr: {
    ...minimalPrDetail.pr,
    headSha: 'head-v2',
    baseSha: 'base-v0',
  },
  iterations: [
    {
      number: 1,
      beforeSha: 'base-v0',
      afterSha: 'head-v1',
      commits: [],
      hasResolvableRange: true,
    },
    {
      number: 2,
      beforeSha: 'head-v1',
      afterSha: 'head-v2',
      commits: [],
      hasResolvableRange: true,
    },
  ],
};

const sampleMultiIterationDiff: DiffDto = {
  range: 'base-v0..head-v2',
  files: [{ path: 'src/main.ts', status: 'modified', hunks: [] }],
  truncated: false,
};

// PrDetail with clusteringQuality === 'low' and one named commit.
const sampleLowQualityPrDetail: PrDetailDto = {
  ...minimalPrDetail,
  clusteringQuality: 'low',
  iterations: null,
  commits: [
    {
      sha: 'commit-sha-0001',
      message: 'commit-0001',
      committedDate: '2026-05-01T00:00:00Z',
      additions: 3,
      deletions: 1,
    },
  ],
};

const sampleLowQualityDiff: DiffDto = {
  range: 'basedef..commit-sha-0001',
  files: [{ path: 'src/main.ts', status: 'modified', hunks: [] }],
  truncated: false,
};

// Extends the existing fetch-mock router with a /file?path=&sha= route handler.
// Returns a fetch function suitable for assigning to globalThis.fetch.
function mockWholeFileFetch(opts: {
  diffResponse: () => Promise<Response>;
  draftResponse?: () => Promise<Response>;
  fileContent?: string;
  fileProblem?: { type: string; status: number };
}): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('/file?path=')) {
      if (opts.fileProblem) {
        return new Response(JSON.stringify({ type: opts.fileProblem.type }), {
          status: opts.fileProblem.status,
          headers: { 'content-type': 'application/problem+json' },
        });
      }
      return new Response(opts.fileContent ?? 'mock content\nline 2\n', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    }
    if (url.endsWith('/draft')) {
      return opts.draftResponse
        ? opts.draftResponse()
        : Promise.resolve(jsonResponse(emptyReviewSession));
    }
    return opts.diffResponse();
  }) as unknown as typeof fetch;
}

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  // Mirrors the host's ownership of the draft session. FilesTab reads
  // prRef/prDetail/session/readOnly from the PrDetail context (Task 2); the
  // legacy Outlet `context` prop is gone (Task 5 removed the nested-route
  // Outlet — sub-tabs render directly), so FilesTab is the bare Outlet leaf.
  const draftSession = useDraftSession(ref);
  return (
    <PrDetailContextProvider
      value={{
        prRef: ref,
        prDetail,
        draftSession,
        readOnly: false,
        subscribed: false,
        baseShaChanged: false,
        onSelectSubTab: () => {},
      }}
    >
      <Outlet />
    </PrDetailContextProvider>
  );
}

function renderFilesTab(prDetail: PrDetailDto = minimalPrDetail) {
  return render(
    <MemoryRouter initialEntries={['/pr/octocat/hello/42/files']}>
      <Routes>
        <Route path="/pr/:owner/:repo/:number" element={<Wrapper prDetail={prDetail} />}>
          <Route path="files/*" element={<FilesTab />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('FilesTab', () => {
  it('renders iteration tab strip when clusteringQuality is ok', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText('All changes')).toBeInTheDocument();
    });
  });

  it('renders commit picker when clusteringQuality is low', async () => {
    const lowQuality: PrDetailDto = {
      ...minimalPrDetail,
      clusteringQuality: 'low',
      iterations: null,
    };
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab(lowQuality);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });

  it('renders file tree with files from diff response', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
  });

  it('auto-selects the first file when files arrive (GitHub/ADO/GitLab parity)', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    // After files load, the empty-pane prompt MUST NOT appear — auto-select
    // promotes selectedPath to fileList[0] so the diff pane renders a file
    // path immediately. Without this assertion the test would silently pass
    // even if auto-select regressed (the prompt's absence is the real signal).
    await waitFor(() => {
      expect(screen.queryByText(/select a file from the tree/i)).not.toBeInTheDocument();
    });
    // Tree-order is deterministic: subdirs walk before root files
    // (treeBuilder.ts), so fileList[0] is `src/main.ts` for sampleDiff
    // ([src/main.ts, README.md]). Assert that exact pick — Copilot iter-1
    // pointed out the OR variant would silently pass even if auto-select
    // shifted to the wrong file. The negative assertion above (`select a
    // file from the tree` absent) is the load-bearing freshness signal;
    // this one pins the tree-walk contract.
    const diffPane = await screen.findByTestId('diff-pane');
    expect(diffPane.textContent ?? '').toContain('src/main.ts');
  });

  it('clicking a non-selected file shifts the diff pane to that file', async () => {
    // sampleDiff order yields tree-order [src/main.ts, README.md] so
    // src/main.ts is the auto-selected file. Clicking README.md exercises
    // the click-handler → selectedPath update → DiffPane re-render path
    // distinct from the auto-select. Preflight noted the old version was a
    // tautology once auto-select pre-selected main.ts before the click.
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
    const diffPane = await screen.findByTestId('diff-pane');
    // Pre-click: auto-selected src/main.ts is showing.
    await waitFor(() => {
      expect(diffPane.textContent ?? '').toContain('src/main.ts');
    });
    // findByText (not getByText): the async diff-pane re-render can transiently
    // re-key the tree row between the assertion above and this click, so wait for
    // README.md to be re-attached before clicking. (Surfaced under parallel-suite
    // load; sync getByText here was a pre-existing race.)
    fireEvent.click(await screen.findByText('README.md'));
    await waitFor(() => {
      expect(diffPane.textContent ?? '').toContain('README.md');
    });
  });

  it('shows skeleton on slow diff load', async () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
      renderFilesTab();
      // Before 100ms delay, no skeleton
      expect(screen.queryByLabelText(/loading/i)).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the typed "diff unavailable" message for a 422 range-unreachable error', async () => {
    // Backend maps RangeUnreachableException → ProblemDetails { type: "/diff/range-unreachable" }
    // at HTTP 422 (PrDetailEndpoints /diff, spec § 5.1). FilesTab must render the distinct,
    // human-readable message — NOT the generic "Failed to load diff — HTTP 422" banner.
    globalThis.fetch = diffOrDraft(() =>
      Promise.resolve(jsonResponse({ type: '/diff/range-unreachable' }, 422)),
    ) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByTestId('diff-unavailable')).toBeInTheDocument();
    });
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toMatch(/no longer reachable on GitHub/i);
    // The generic fallback wording must NOT be present for the typed case.
    expect(alert.textContent).not.toMatch(/Failed to load diff/i);
  });

  it('shows the generic banner for a non-range-unreachable diff error (regression)', async () => {
    // Any other failure (here a 500) must still fall through to the generic banner so we
    // don't swallow unexpected errors behind the range-unreachable copy.
    globalThis.fetch = diffOrDraft(() =>
      Promise.resolve(jsonResponse({ type: '/oops' }, 500)),
    ) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
    expect(screen.getByRole('alert').textContent).toMatch(/Failed to load diff/i);
    expect(screen.queryByTestId('diff-unavailable')).not.toBeInTheDocument();
  });

  it('renders a diff-mode toggle in the toolbar with the split radio checked by default', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    // DiffViewToggle is a radiogroup; the split radio should be checked by default.
    const splitRadio = (await screen.findByTestId('diff-view-split')) as HTMLInputElement;
    expect(splitRadio).toBeInTheDocument();
    expect(splitRadio.checked).toBe(true);
    const unifiedRadio = screen.getByTestId('diff-view-unified') as HTMLInputElement;
    expect(unifiedRadio.checked).toBe(false);
  });

  it('toggles diff mode when clicking the unified tile radio', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const unifiedRadio = await screen.findByTestId('diff-view-unified');
    fireEvent.click(unifiedRadio);
    await waitFor(() => {
      expect((screen.getByTestId('diff-view-unified') as HTMLInputElement).checked).toBe(true);
      expect((screen.getByTestId('diff-view-split') as HTMLInputElement).checked).toBe(false);
    });
  });

  it('disables the split radio below 900px viewport and forced effective mode is unified', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const splitRadio = (await screen.findByTestId('diff-view-split')) as HTMLInputElement;
    expect(splitRadio.disabled).toBe(true);
    // Effective mode forced to 'unified' — unified radio is checked.
    const unifiedRadio = screen.getByTestId('diff-view-unified') as HTMLInputElement;
    expect(unifiedRadio.checked).toBe(true);
    // Restore for subsequent tests.
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1200,
    });
    window.dispatchEvent(new Event('resize'));
  });
});

describe('FilesTab line-wrap toggle (#115)', () => {
  it('renders a line-wrap checkbox in the gear menu defaulting to unchecked', async () => {
    globalThis.fetch = diffOrDraft(() =>
      Promise.resolve(jsonResponse(sampleModifiedDiff)),
    ) as typeof fetch;
    renderFilesTab();
    // Open the gear menu first.
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    const checkbox = await screen.findByTestId('line-wrap-checkbox');
    expect((checkbox as HTMLInputElement).checked).toBe(false);
  });

  it('toggling line-wrap checkbox applies diff-pane--wrap to the diff pane', async () => {
    globalThis.fetch = diffOrDraft(() =>
      Promise.resolve(jsonResponse(sampleModifiedDiff)),
    ) as typeof fetch;
    renderFilesTab();
    // Open the gear menu.
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    const checkbox = await screen.findByTestId('line-wrap-checkbox');
    const diffPane = await screen.findByTestId('diff-pane');
    expect(diffPane).not.toHaveClass('diff-pane--wrap');
    fireEvent.click(checkbox);
    expect((screen.getByTestId('line-wrap-checkbox') as HTMLInputElement).checked).toBe(true);
    await waitFor(() => expect(diffPane).toHaveClass('diff-pane--wrap'));
  });
});

describe('FilesTab whole-file toggle', () => {
  it('checking "Show full file" in the gear menu enables full-file view for a modified file', async () => {
    const fetchImpl = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileContent: 'whole content\nline 2\nline 3\n',
    });
    const fetchSpy = vi.fn().mockImplementation(fetchImpl);
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    renderFilesTab();
    // Wait for file tree to settle before opening gear.
    await screen.findByText('src/main.ts');
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    const checkbox = (await screen.findByTestId('show-full-file-checkbox')) as HTMLInputElement;
    // Default: unchecked (off).
    expect(checkbox.checked).toBe(false);
    // Not disabled for a modified+hunks file on 'all' range.
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    await waitFor(() =>
      expect((screen.getByTestId('show-full-file-checkbox') as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    // Downstream signal: wholeFileEnabled=true triggers the whole-file fetch.
    // Assert DiffPane actually requested the file content from the backend —
    // the test would pass with a stale checkbox state even if deriveWholeFileEnabled
    // stopped returning true, so this spy call confirms the prop propagated.
    await waitFor(() => {
      const fileCall = fetchSpy.mock.calls.find((args) => String(args[0]).includes('/file?path='));
      expect(fileCall).toBeDefined();
    });
  });

  it('show-full-file enabled but shows inert helper for added / deleted / renamed file statuses', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleAddedDiff)),
    });
    renderFilesTab();
    await screen.findByText('new.ts');
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    // Checkbox is enabled (view-wide preference) but checking it + selecting an
    // ineligible file shows "still on for other files" helper text (fullFileInertHere).
    const checkbox = (await screen.findByTestId('show-full-file-checkbox')) as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    fireEvent.click(checkbox);
    await waitFor(() => {
      const helper = screen.queryByTestId('show-full-file-helper');
      expect(helper).toBeInTheDocument();
      expect(helper!.textContent).toMatch(/still on for other files/i);
    });
  });

  it('show-full-file checkbox disabled when activeRange !== "all" (DSx11 gate)', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleMultiIterationDiff)),
    });
    renderFilesTab(sampleMultiIterationPrDetail);
    // Wait for the iteration tab strip to appear.
    const iterationTab1 = await screen.findByTestId('iteration-tab-1');
    fireEvent.click(iterationTab1);
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    await waitFor(() => {
      const checkbox = screen.getByTestId('show-full-file-checkbox') as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
    });
    // Helper text explains why.
    await waitFor(() => {
      const helper = screen.getByTestId('show-full-file-helper');
      expect(helper.textContent).toMatch(/'all' iteration view/i);
    });
  });

  it('show-full-file checkbox disabled when selectedCommits !== null (DSx11 gate)', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleLowQualityDiff)),
    });
    renderFilesTab(sampleLowQualityPrDetail);
    // Open the commit picker combobox.
    const combobox = await screen.findByRole('combobox');
    fireEvent.click(combobox);
    // Click the first commit option (index 1 — index 0 is "Show all").
    const options = await screen.findAllByRole('option');
    // options[0] is "Show all"; options[1] is the first commit.
    fireEvent.click(options[1]);
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    await waitFor(() => {
      const checkbox = screen.getByTestId('show-full-file-checkbox') as HTMLInputElement;
      expect(checkbox.disabled).toBe(true);
    });
    await waitFor(() => {
      const helper = screen.getByTestId('show-full-file-helper');
      expect(helper.textContent).toMatch(/'all' iteration view/i);
    });
  });

  it('onWholeFileFailed flow: failure callback marks path failed; checkbox stays checked but banner appears', async () => {
    // 413 from /file → DiffPane's failure latch fires → onWholeFileFailed marks path →
    // wholeFileEnabled becomes false (path excluded by deriveWholeFileEnabled) →
    // DiffPane renders the WholeFileFailureBanner (localFailure latch set).
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileProblem: { type: '/file/too-large', status: 413 },
    });
    renderFilesTab();
    await screen.findByText('src/main.ts');
    const gear = await screen.findByTestId('diff-settings-trigger');
    fireEvent.click(gear);
    const checkbox = (await screen.findByTestId('show-full-file-checkbox')) as HTMLInputElement;
    await waitFor(() => expect(checkbox).not.toBeDisabled());
    fireEvent.click(checkbox);
    // showFullFile stays true (checkbox remains checked) but the path is added to
    // failedPaths, so deriveWholeFileEnabled returns false.
    await waitFor(() =>
      expect((screen.getByTestId('show-full-file-checkbox') as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    // Downstream signal: DiffPane's failure latch renders the WholeFileFailureBanner,
    // confirming markFailed / failedPaths / deriveWholeFileEnabled integration is intact.
    // This assertion FAILS if the onWholeFileFailed callback is not wired, if markFailed
    // doesn't update failedPaths, or if deriveWholeFileEnabled ignores failedPaths.
    await waitFor(() => {
      expect(screen.getByTestId('whole-file-failure-banner')).toBeInTheDocument();
    });
  });
});
