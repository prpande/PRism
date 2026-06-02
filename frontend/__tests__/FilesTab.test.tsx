import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  // Mirrors PrDetailPage's hoisted ownership of the draft session in S4 PR6.
  const draftSession = useDraftSession(ref);
  return <Outlet context={{ prDetail, draftSession }} />;
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

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

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
    fireEvent.click(screen.getByText('README.md'));
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

  it('shows error when diff fetch fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ type: '/diff/range-unreachable' }, 404)),
      ) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
    });
  });

  it('renders a diff-mode toggle button in the toolbar with stateful label and aria-pressed', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const toggleButton = await screen.findByRole('button', { name: /side-by-side|unified/i });
    expect(toggleButton).toBeInTheDocument();
    expect(toggleButton.getAttribute('aria-pressed')).toBe('true'); // default is 'side-by-side'
    expect(toggleButton.textContent).toMatch(/side-by-side/i);
  });

  it('toggles diff mode when clicked', async () => {
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const toggleButton = await screen.findByRole('button', { name: /side-by-side|unified/i });
    fireEvent.click(toggleButton);
    expect(toggleButton.getAttribute('aria-pressed')).toBe('false');
    expect(toggleButton.textContent).toMatch(/unified/i);
  });

  it('disables the toggle button below 900px viewport and aria-pressed reflects forced effective mode', async () => {
    Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 800 });
    window.dispatchEvent(new Event('resize'));
    globalThis.fetch = diffOrDraft(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    const toggleButton = (await screen.findByRole('button', {
      name: /side-by-side|unified/i,
    })) as HTMLButtonElement;
    expect(toggleButton.disabled).toBe(true);
    // Effective mode forced to 'unified' by the viewport gate; aria-pressed
    // and label both reflect THAT (not the stored diffMode).
    expect(toggleButton.getAttribute('aria-pressed')).toBe('false');
    expect(toggleButton.textContent).toMatch(/unified/i);
    // Restore for subsequent tests.
    Object.defineProperty(window, 'innerWidth', {
      writable: true,
      configurable: true,
      value: 1200,
    });
    window.dispatchEvent(new Event('resize'));
  });
});

describe('FilesTab whole-file toggle', () => {
  it('clicking "Show full file" on a modified file flips the button label and sets aria-pressed', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileContent: 'whole content\nline 2\nline 3\n',
    });
    renderFilesTab();
    // Wait for the button to be enabled (diff loaded + auto-select settled).
    const button = await screen.findByTestId('whole-file-toggle');
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(button).toHaveTextContent('Show full file');
    expect(button).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Hunks only'));
    expect(button).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggle disabled for added / deleted / renamed file statuses', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleAddedDiff)),
    });
    renderFilesTab();
    // Wait for the diff to load and auto-select to settle (selectedFile is set).
    await waitFor(() => expect(screen.getByText('new.ts')).toBeInTheDocument());
    const button = screen.getByTestId('whole-file-toggle');
    expect(button).toBeDisabled();
    expect(button.getAttribute('title')).toMatch(/modified files only/i);
  });

  it('toggle disabled when activeRange !== "all" (DSx11 gate)', async () => {
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleMultiIterationDiff)),
    });
    renderFilesTab(sampleMultiIterationPrDetail);
    // Wait for the iteration tab strip to appear.
    const iterationTab1 = await screen.findByTestId('iteration-tab-1');
    fireEvent.click(iterationTab1);
    await waitFor(() => {
      const button = screen.getByTestId('whole-file-toggle');
      expect(button).toBeDisabled();
    });
    const button = screen.getByTestId('whole-file-toggle');
    expect(button.getAttribute('title')).toMatch(/'all' iteration view/i);
  });

  it('toggle disabled when selectedCommits !== null (DSx11 gate)', async () => {
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
    await waitFor(() => {
      const button = screen.getByTestId('whole-file-toggle');
      expect(button).toBeDisabled();
    });
    const button = screen.getByTestId('whole-file-toggle');
    expect(button.getAttribute('title')).toMatch(/'all' iteration view/i);
  });

  it('onWholeFileFailed flow: failure callback removes path from wholeFilePaths; button reverts', async () => {
    // 413 from /file → DiffPane's failure latch fires → onWholeFileFailed removes path → button reverts.
    globalThis.fetch = mockWholeFileFetch({
      diffResponse: () => Promise.resolve(jsonResponse(sampleModifiedDiff)),
      fileProblem: { type: '/file/too-large', status: 413 },
    });
    renderFilesTab();
    const button = await screen.findByTestId('whole-file-toggle');
    fireEvent.click(button);
    await waitFor(() => expect(button).toHaveTextContent('Show full file'));
    expect(button).toHaveAttribute('aria-pressed', 'false');
  });
});
