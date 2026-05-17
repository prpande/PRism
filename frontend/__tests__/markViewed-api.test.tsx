import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postMarkViewed } from '../src/api/markViewed';
import { ApiError } from '../src/api/client';
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
    await expect(
      postMarkViewed(ref, { headSha: 'x', maxCommentId: null }),
    ).resolves.toBeUndefined();
  });

  it('throws ApiError on 422 with the parsed body and status preserved', async () => {
    // Stronger than `.rejects.toThrow('HTTP 422')` — that substring also
    // matches a plain `Error('HTTP 422 something')`. Future callers
    // discriminating snapshot-evicted from other 422s need ApiError.body.type
    // and ApiError.status to be intact, not just the message string.
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ type: '/viewed/snapshot-evicted' }), {
          status: 422,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ) as typeof fetch;
    let caught: unknown;
    try {
      await postMarkViewed(ref, { headSha: 'x', maxCommentId: null });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    const apiErr = caught as ApiError;
    expect(apiErr.status).toBe(422);
    expect(apiErr.body).toEqual({ type: '/viewed/snapshot-evicted' });
  });

  it('sends the X-PRism-Tab-Id header so the backend cross-tab signal stays consistent', async () => {
    // Other writers (PUT /draft, POST /submit, POST /reload) all send the
    // tab-id; mark-viewed not sending it caused header drift the next time the
    // BE wanted to use the signal. Mirror via tabIdHeaders() in markViewed.ts.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchMock as typeof fetch;
    await postMarkViewed(ref, { headSha: 'x', maxCommentId: null });
    const headers = (fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['X-PRism-Tab-Id']).toBeTruthy();
  });

  it('forwards an AbortSignal to fetch so callers can cancel in-flight stamps', async () => {
    // usePrDetail relies on this to prevent a slow A-stamp landing after a fast
    // B-stamp on rapid PR navigation. Without forwarding the signal, the abort
    // is a no-op and the race window stays open.
    const fetchMock = vi
      .fn()
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    globalThis.fetch = fetchMock as typeof fetch;
    const controller = new AbortController();
    await postMarkViewed(ref, { headSha: 'x', maxCommentId: null }, { signal: controller.signal });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});
