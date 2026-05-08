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

  it('clears stale data while the next fetch is in flight when prRef changes', async () => {
    // Regression: React Router reuses the same PrDetailPage instance when
    // navigating between PRs, so without an explicit setData(null) on prRef
    // change, users briefly see the previous PR's title/author under the new
    // URL until the new fetch resolves.
    let resolveSecond!: (resp: Response) => void;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(jsonResponse(minimalDto));
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    }) as typeof fetch;

    const { result, rerender } = renderHook(
      (props: { prRef: PrReference }) => usePrDetail(props.prRef),
      { initialProps: { prRef: ref } },
    );
    await waitFor(() => expect(result.current.data).not.toBeNull());

    rerender({ prRef: { owner: 'foo', repo: 'bar', number: 99 } });
    expect(result.current.data).toBeNull();
    expect(result.current.isLoading).toBe(true);

    act(() =>
      resolveSecond(
        jsonResponse({
          ...minimalDto,
          pr: {
            ...minimalDto.pr,
            title: 'Second PR',
            reference: { owner: 'foo', repo: 'bar', number: 99 },
          },
        }),
      ),
    );
    await waitFor(() => expect(result.current.data?.pr.title).toBe('Second PR'));
  });

  it('preserves existing data while reload() is in flight (same prRef)', async () => {
    // Regression: clicking Reload should not blank the header/title/author.
    // Prior implementation cleared `data` on every effect run (including
    // reloadCounter changes), causing a brief empty-UI flash before the
    // skeleton appeared. Stale data should only be cleared on PR navigation.
    let resolveSecond!: (resp: Response) => void;
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(jsonResponse(minimalDto));
      return new Promise<Response>((resolve) => {
        resolveSecond = resolve;
      });
    }) as typeof fetch;

    const { result } = renderHook(() => usePrDetail(ref));
    await waitFor(() => expect(result.current.data).not.toBeNull());
    const firstData = result.current.data;

    act(() => result.current.reload());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBe(firstData);
    expect(result.current.error).toBeNull();

    act(() =>
      resolveSecond(
        jsonResponse({
          ...minimalDto,
          pr: { ...minimalDto.pr, title: 'Refreshed' },
        }),
      ),
    );
    await waitFor(() => expect(result.current.data?.pr.title).toBe('Refreshed'));
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
