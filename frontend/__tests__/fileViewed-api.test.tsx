import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postFileViewed } from '../src/api/fileViewed';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postFileViewed', () => {
  it('calls POST /api/pr/{ref}/files/viewed with path, headSha, viewed', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchMock as typeof fetch;
    await postFileViewed(ref, { path: 'src/main.ts', headSha: 'abc123', viewed: true });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42/files/viewed');
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ path: 'src/main.ts', headSha: 'abc123', viewed: true });
  });

  it('resolves on 204', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      ) as typeof fetch;
    await expect(
      postFileViewed(ref, { path: 'a.ts', headSha: 'x', viewed: true }),
    ).resolves.toBeUndefined();
  });

  it('throws ApiError on 422', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: '/viewed/cap-exceeded' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as typeof fetch;
    await expect(postFileViewed(ref, { path: 'a.ts', headSha: 'x', viewed: true })).rejects.toThrow(
      'HTTP 422',
    );
  });

  it('throws ApiError on 409', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: '/viewed/stale-head-sha' }), {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as typeof fetch;
    await expect(postFileViewed(ref, { path: 'a.ts', headSha: 'x', viewed: true })).rejects.toThrow(
      'HTTP 409',
    );
  });
});
