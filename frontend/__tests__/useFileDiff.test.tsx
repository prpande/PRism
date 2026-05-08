import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFileDiff } from '../src/hooks/useFileDiff';
import type { DiffDto, PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const sampleDiff: DiffDto = {
  range: 'abc..def',
  files: [
    {
      path: 'src/main.ts',
      status: 'modified',
      hunks: [
        { oldStart: 1, oldLines: 3, newStart: 1, newLines: 5, body: '@@ -1,3 +1,5 @@\n+foo' },
      ],
    },
  ],
  truncated: false,
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

describe('useFileDiff', () => {
  it('initial state has isLoading=true, data=null, error=null', () => {
    globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
    const { result } = renderHook(() => useFileDiff(ref, 'abc..def'));
    expect(result.current.isLoading).toBe(true);
    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeNull();
  });

  it('returns data on successful fetch', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff))) as typeof fetch;
    const { result } = renderHook(() => useFileDiff(ref, 'abc..def'));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data?.files).toHaveLength(1);
    expect(result.current.error).toBeNull();
  });

  it('returns error on fetch failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ type: '/diff/range-unreachable' }, 404)),
      ) as typeof fetch;
    const { result } = renderHook(() => useFileDiff(ref, 'abc..def'));
    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.data).toBeNull();
  });

  it('does not fetch when range is null', () => {
    const fetchMock = vi.fn().mockImplementation(() => new Promise(() => {}));
    globalThis.fetch = fetchMock as typeof fetch;
    const { result } = renderHook(() => useFileDiff(ref, null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetches when range changes', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff)));
    globalThis.fetch = fetchMock as typeof fetch;
    const { rerender } = renderHook((props: { range: string }) => useFileDiff(ref, props.range), {
      initialProps: { range: 'abc..def' },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ range: 'ghi..jkl' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it('composes useDelayedLoading for showSkeleton', () => {
    vi.useFakeTimers();
    try {
      globalThis.fetch = vi.fn().mockImplementation(() => new Promise(() => {})) as typeof fetch;
      const { result } = renderHook(() => useFileDiff(ref, 'abc..def'));
      expect(result.current.showSkeleton).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
