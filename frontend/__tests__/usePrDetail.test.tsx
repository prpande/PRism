import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PrDetailDto, PrReference } from '../src/api/types';
import { usePrDetail } from '../src/hooks/usePrDetail';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const minimalDto: PrDetailDto = {
  pr: {
    reference: ref,
    title: 'Refactor the renewal worker',
    body: '',
    author: 'amelia.cho',
    state: 'open',
    headSha: 'abc',
    baseSha: 'def',
    headBranch: 'amelia/work',
    baseBranch: 'main',
    mergeability: 'mergeable',
    ciSummary: 'success',
    isMerged: false,
    isClosed: false,
    openedAt: '2026-05-01T00:00:00Z',
  },
  clusteringQuality: 'ok',
  iterations: [],
  commits: [],
  rootComments: [],
  reviewComments: [],
  timelineCapHit: false,
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('usePrDetail', () => {
  it('initial state has isLoading=true, data=null, error=null', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
    const { result } = renderHook(() => usePrDetail(ref));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns data + isLoading=false on successful fetch', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(minimalDto))) as typeof fetch;
    const { result } = renderHook(() => usePrDetail(ref));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.pr.title).toBe('Refactor the renewal worker');
    expect(result.current.error).toBeNull();
  });

  it('returns error on fetch failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ error: 'not found' }, 404)),
      ) as typeof fetch;
    const { result } = renderHook(() => usePrDetail(ref));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('calls /api/pr/{owner}/{repo}/{number}', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(minimalDto)));
    globalThis.fetch = fetchMock as typeof fetch;
    renderHook(() => usePrDetail(ref));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42');
  });

  it('reload() triggers a re-fetch', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(minimalDto)));
    globalThis.fetch = fetchMock as typeof fetch;
    const { result } = renderHook(() => usePrDetail(ref));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.reload());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('refetches when prRef changes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(minimalDto)));
    globalThis.fetch = fetchMock as typeof fetch;
    const { rerender } = renderHook((props: { prRef: PrReference }) => usePrDetail(props.prRef), {
      initialProps: { prRef: ref },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ prRef: { owner: 'foo', repo: 'bar', number: 99 } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[1][0]).toBe('/api/pr/foo/bar/99');
  });

  it('skeleton timing: showSkeleton=false within first 100ms of loading', () => {
    vi.useFakeTimers();
    try {
      vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
      globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
      const { result } = renderHook(() => usePrDetail(ref));
      expect(result.current.showSkeleton).toBe(false);
      act(() => {
        vi.advanceTimersByTime(99);
      });
      expect(result.current.showSkeleton).toBe(false);
      act(() => {
        vi.advanceTimersByTime(2);
      });
      expect(result.current.showSkeleton).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
