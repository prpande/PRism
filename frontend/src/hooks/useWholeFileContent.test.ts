import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { FileChange, PrReference } from '../api/types';
import { useWholeFileContent } from './useWholeFileContent';

const prRef: PrReference = { owner: 'o', repo: 'r', number: 1 };
const modifiedFile: FileChange = {
  path: 'src/a.ts',
  status: 'modified',
  hunks: [
    { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, body: '@@ -1,1 +1,1 @@\n-old\n+new' },
  ],
};

function mockFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = vi.fn((input: RequestInfo | URL) => impl(String(input))) as typeof fetch;
}

function okText(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/plain' } });
}

function problem(type: string, status: number): Response {
  return new Response(JSON.stringify({ type }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

describe('useWholeFileContent', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('1. enabled false → idle, no fetch fired', () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;
    const { result } = renderHook(() =>
      useWholeFileContent({
        prRef,
        path: 'src/a.ts',
        file: modifiedFile,
        headSha: 'h',
        baseSha: 'b',
        enabled: false,
        isSplit: false,
      }),
    );
    expect(result.current.fetchStatus).toBe('idle');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('2. unified, 200 head → ok with headContent', async () => {
    mockFetch(async (url) => {
      expect(url).toContain('sha=h');
      return okText('a\nb\nc');
    });
    const { result } = renderHook(() =>
      useWholeFileContent({
        prRef,
        path: 'src/a.ts',
        file: modifiedFile,
        headSha: 'h',
        baseSha: 'b',
        enabled: true,
        isSplit: false,
      }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect(result.current.headContent).toBe('a\nb\nc');
    expect(result.current.baseContent).toBeNull();
  });

  it('3. split, 200 head + 200 base → ok with both contents', async () => {
    mockFetch(async (url) =>
      url.includes('sha=h') ? okText('new-content') : okText('old-content'),
    );
    const { result } = renderHook(() =>
      useWholeFileContent({
        prRef,
        path: 'src/a.ts',
        file: modifiedFile,
        headSha: 'h',
        baseSha: 'b',
        enabled: true,
        isSplit: true,
      }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect(result.current.headContent).toBe('new-content');
    expect(result.current.baseContent).toBe('old-content');
  });

  it('4. unified, 413 head → failed with mapped reason', async () => {
    mockFetch(async () => problem('/file/too-large', 413));
    const { result } = renderHook(() =>
      useWholeFileContent({
        prRef,
        path: 'src/a.ts',
        file: modifiedFile,
        headSha: 'h',
        baseSha: 'b',
        enabled: true,
        isSplit: false,
      }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('failed'));
    expect(result.current.failureReason).toBe('file is too large to expand');
  });

  it('5. split, 200 head + 413 base → failed with old-side prefix', async () => {
    mockFetch(async (url) =>
      url.includes('sha=h') ? okText('new-content') : problem('/file/too-large', 413),
    );
    const { result } = renderHook(() =>
      useWholeFileContent({
        prRef,
        path: 'src/a.ts',
        file: modifiedFile,
        headSha: 'h',
        baseSha: 'b',
        enabled: true,
        isSplit: true,
      }),
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('failed'));
    expect(result.current.failureReason).toBe('old-side file is too large to expand');
  });

  it('6. cache reuse: same key after re-enable does not re-fetch', async () => {
    const fetchSpy = vi.fn(async () => okText('cached-content')) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useWholeFileContent({
          prRef,
          path: 'src/a.ts',
          file: modifiedFile,
          headSha: 'h',
          baseSha: 'b',
          enabled,
          isSplit: false,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    const initialCalls = (fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length;
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(initialCalls);
    // Cached content matches the original fetch — guards against a cache hit
    // returning 'ok' status but stale/null content.
    expect(result.current.headContent).toBe('cached-content');
  });

  it('7. failed result is NOT cached — re-enable re-fetches so transient failures are recoverable', async () => {
    // claude[bot] post-open Finding 1: caching failed results made transient
    // failures (network blip, 401, snapshot-evicted) un-recoverable — the user
    // would dismiss the banner, click "Show full file" again, and get the
    // stale failure synchronously from the cache without a retry path. Fix:
    // only cache 'ok' results.
    let callCount = 0;
    const fetchSpy = vi.fn(async () => {
      callCount += 1;
      // Fail on first call (transient), succeed on second call (retry).
      return callCount === 1 ? problem('/file/too-large', 413) : okText('retry-content');
    }) as unknown as typeof fetch;
    globalThis.fetch = fetchSpy;
    const { result, rerender } = renderHook(
      ({ enabled }) =>
        useWholeFileContent({
          prRef,
          path: 'src/a.ts',
          file: modifiedFile,
          headSha: 'h',
          baseSha: 'b',
          enabled,
          isSplit: false,
        }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.fetchStatus).toBe('failed'));
    expect(result.current.failureReason).toBe('file is too large to expand');
    expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

    // User dismisses banner + toggles off + toggles back on (re-enable).
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.fetchStatus).toBe('ok'));
    // A second fetch fires (cache did NOT serve the cached failure).
    expect((fetchSpy as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
    expect(result.current.headContent).toBe('retry-content');
  });
});
