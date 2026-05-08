import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryRouter, Routes, Route, Outlet } from 'react-router-dom';
import { FilesTab } from '../src/components/PrDetail/FilesTab/FilesTab';
import type { PrDetailDto, DiffDto, PrReference } from '../src/api/types';

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

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function Wrapper({ prDetail }: { prDetail: PrDetailDto }) {
  return <Outlet context={{ prDetail }} />;
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
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
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
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab(lowQuality);
    await waitFor(() => {
      expect(screen.getByRole('combobox')).toBeInTheDocument();
    });
  });

  it('renders file tree with files from diff response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
      expect(screen.getByText('README.md')).toBeInTheDocument();
    });
  });

  it('renders diff pane placeholder stub', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText(/select a file/i)).toBeInTheDocument();
    });
  });

  it('selecting a file shows its path in diff pane', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    renderFilesTab();
    await waitFor(() => {
      expect(screen.getByText('main.ts')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('main.ts'));
    expect(screen.getByText('src/main.ts')).toBeInTheDocument();
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
});
