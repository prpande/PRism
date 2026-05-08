import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getDiff, getDiffByCommits } from '../src/api/diff';
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

describe('getDiff', () => {
  it('calls GET /api/pr/{ref}/diff?range=<range>', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff)));
    globalThis.fetch = fetchMock as typeof fetch;
    const result = await getDiff(ref, 'abc..def');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42/diff?range=abc..def');
    expect(result.files).toHaveLength(1);
    expect(result.truncated).toBe(false);
  });

  it('propagates ApiError on non-ok response', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(jsonResponse({ type: '/diff/range-unreachable' }, 404)),
      ) as typeof fetch;
    await expect(getDiff(ref, 'abc..def')).rejects.toThrow('HTTP 404');
  });
});

describe('getDiffByCommits', () => {
  it('calls GET /api/pr/{ref}/diff?commits=sha1,sha2', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse(sampleDiff)));
    globalThis.fetch = fetchMock as typeof fetch;
    await getDiffByCommits(ref, ['sha1', 'sha2']);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42/diff?commits=sha1,sha2');
  });
});
