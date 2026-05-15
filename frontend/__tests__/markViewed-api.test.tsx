import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postMarkViewed } from '../src/api/markViewed';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

beforeEach(() => {
  vi.spyOn(document, 'cookie', 'get').mockReturnValue('');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postMarkViewed', () => {
  it('calls POST /api/pr/{ref}/mark-viewed with headSha and maxCommentId', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchMock as typeof fetch;
    await postMarkViewed(ref, { headSha: 'abc123', maxCommentId: '99' });
    expect(fetchMock.mock.calls[0][0]).toBe('/api/pr/octocat/hello/42/mark-viewed');
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ headSha: 'abc123', maxCommentId: '99' });
  });

  it('serializes maxCommentId=null when no comments are present', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchMock as typeof fetch;
    await postMarkViewed(ref, { headSha: 'abc123', maxCommentId: null });
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({ headSha: 'abc123', maxCommentId: null });
  });

  it('resolves on 204', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 204 })),
      ) as typeof fetch;
    await expect(postMarkViewed(ref, { headSha: 'x', maxCommentId: null })).resolves.toBeUndefined();
  });

  it('throws ApiError on 422', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: '/viewed/snapshot-evicted' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as typeof fetch;
    await expect(postMarkViewed(ref, { headSha: 'x', maxCommentId: null })).rejects.toThrow(
      'HTTP 422',
    );
  });
});
