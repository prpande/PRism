import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
// The real ApiError is { status, requestId, body } (client.ts:4-14) — the kebab code lives
// inside `body`, not a `.code` field. The mock MUST mirror that shape or the test false-passes
// against a contract the backend never emits.
vi.mock('./client', () => ({
  apiClient: { post: (...a: unknown[]) => post(...a) },
  ApiError: class ApiError extends Error {
    status: number;
    requestId: string | null;
    body: unknown;
    constructor(status: number, requestId: string | null, body: unknown) {
      super(String(status));
      this.status = status;
      this.requestId = requestId;
      this.body = body;
    }
  },
}));

import { resolveThread, unresolveThread } from './reviewThread';
import { ApiError } from './client';

const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('reviewThread client', () => {
  beforeEach(() => post.mockReset());

  it('resolveThread POSTs the resolve path with threadId and returns ok on success', async () => {
    post.mockResolvedValueOnce(undefined);
    const r = await resolveThread(prRef, 'PRRT_1');
    expect(post).toHaveBeenCalledWith('/api/pr/o/r/1/thread/resolve', { threadId: 'PRRT_1' });
    expect(r).toEqual({ ok: true });
  });

  it('unresolveThread POSTs the unresolve path with threadId and returns ok on success', async () => {
    post.mockResolvedValueOnce(undefined);
    const r = await unresolveThread(prRef, 'PRRT_1');
    expect(post).toHaveBeenCalledWith('/api/pr/o/r/1/thread/unresolve', { threadId: 'PRRT_1' });
    expect(r).toEqual({ ok: true });
  });

  it('maps a 403 token-cannot-write (code in body) to a typed code', async () => {
    post.mockRejectedValueOnce(new ApiError(403, null, { code: 'token-cannot-write' }));
    const r = await resolveThread(prRef, 'PRRT_1');
    expect(r).toEqual({ ok: false, code: 'token-cannot-write' });
  });

  it('maps a 403 "unauthorized" (RequireSubscribed reject) to subscribe-rejected', async () => {
    post.mockRejectedValueOnce(new ApiError(403, null, { code: 'unauthorized' }));
    const r = await resolveThread(prRef, 'PRRT_1');
    expect(r).toEqual({ ok: false, code: 'subscribe-rejected' });
  });

  it('maps a 404 thread-not-found', async () => {
    post.mockRejectedValueOnce(new ApiError(404, null, { code: 'thread-not-found' }));
    const r = await unresolveThread(prRef, 'PRRT_1');
    expect(r).toEqual({ ok: false, code: 'thread-not-found' });
  });

  it('falls back to generic for an unknown code', async () => {
    post.mockRejectedValueOnce(new ApiError(502, null, { code: 'weird' }));
    const r = await resolveThread(prRef, 'PRRT_1');
    expect(r).toEqual({ ok: false, code: 'generic' });
  });

  it('falls back to generic for a non-ApiError throw (e.g. network failure)', async () => {
    post.mockRejectedValueOnce(new Error('network'));
    const r = await resolveThread(prRef, 'PRRT_1');
    expect(r).toEqual({ ok: false, code: 'generic' });
  });
});
