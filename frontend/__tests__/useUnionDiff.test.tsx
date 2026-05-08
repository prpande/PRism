import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useUnionDiff } from '../src/hooks/useUnionDiff';
import type { DiffDto, PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

const sampleDiff: DiffDto = {
  range: 'abc..def',
  files: [{ path: 'src/main.ts', status: 'modified', hunks: [] }],
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

describe('useUnionDiff', () => {
  it('does not fetch when commits is null', () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
    const { result } = renderHook(() => useUnionDiff(ref, null));
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fetches with commits= param when commits provided', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff)));
    globalThis.fetch = fetchMock as typeof fetch;
    const { result } = renderHook(() => useUnionDiff(ref, ['sha1', 'sha2']));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42/diff?commits=sha1,sha2');
    expect(result.current.data?.files).toHaveLength(1);
  });

  it('returns error on failure', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ type: '/diff/range-unreachable' }, 404)),
      ) as typeof fetch;
    const { result } = renderHook(() => useUnionDiff(ref, ['sha1']));
    await waitFor(() => expect(result.current.error).not.toBeNull());
  });

  it('refetches when commits change', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff)));
    globalThis.fetch = fetchMock as typeof fetch;
    const { rerender } = renderHook(
      (props: { commits: string[] | null }) => useUnionDiff(ref, props.commits),
      { initialProps: { commits: ['sha1'] as string[] | null } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ commits: ['sha1', 'sha2'] });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});
