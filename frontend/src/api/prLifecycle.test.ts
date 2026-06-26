import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
// CORRECTED mock: the real ApiError is { status, requestId, body } (client.ts:4-14) — the
// kebab code lives inside `body`, not a `.code` field. The mock MUST mirror that shape or the
// test false-passes against a contract the backend never emits.
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

import { closePr, reopenPr, markReady, convertToDraft } from './prLifecycle';
import { ApiError } from './client';

const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('prLifecycle client', () => {
  beforeEach(() => post.mockReset());

  it('closePr POSTs the close path and returns ok on success', async () => {
    post.mockResolvedValueOnce(undefined);
    const r = await closePr(prRef);
    expect(post).toHaveBeenCalledWith('/api/pr/o/r/1/close');
    expect(r).toEqual({ ok: true });
  });

  it('maps a 403 token-cannot-write (code in body) to a typed code', async () => {
    post.mockRejectedValueOnce(new ApiError(403, null, { code: 'token-cannot-write' }));
    const r = await closePr(prRef);
    expect(r).toEqual({ ok: false, code: 'token-cannot-write' });
  });

  it('maps a 422 reopen-not-possible from reopen', async () => {
    post.mockRejectedValueOnce(new ApiError(422, null, { code: 'reopen-not-possible' }));
    const r = await reopenPr(prRef);
    expect(r).toEqual({ ok: false, code: 'reopen-not-possible' });
  });

  it('falls back to generic for an unknown code', async () => {
    post.mockRejectedValueOnce(new ApiError(502, null, { code: 'something-weird' }));
    const r = await markReady(prRef);
    expect(r).toEqual({ ok: false, code: 'generic' });
  });

  it('maps a 403 "unauthorized" (RequireSubscribed reject) to subscribe-rejected', async () => {
    post.mockRejectedValueOnce(new ApiError(403, null, { code: 'unauthorized' }));
    const r = await convertToDraft(prRef);
    expect(r).toEqual({ ok: false, code: 'subscribe-rejected' });
  });
});
