import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { post, FakeApiError } = vi.hoisted(() => {
  const post = vi.fn();
  class FakeApiError extends Error {
    status: number;
    body: unknown;
    constructor(status: number, body: unknown) {
      super(`status ${status}`);
      this.status = status;
      this.body = body;
    }
  }
  return { post, FakeApiError };
});
vi.mock('./client', () => ({ apiClient: { post }, ApiError: FakeApiError }));

import { postRootComment, KNOWN_POST_ROOT_COMMENT_ERROR_CODES } from './rootComment';

const prRef = { owner: 'acme', repo: 'api', number: 1 };
// See feedback.test.ts: a second unhandledRejection listener makes Vitest defer to
// "user code" so the briefly-unhandled rejected promise (consumed by the awaited
// catch inside postRootComment) doesn't fail the run.
const noop = () => {};

describe('postRootComment error-code handling (#330 — no cast-laundering)', () => {
  beforeEach(() => {
    post.mockReset();
    process.on('unhandledRejection', noop);
  });
  afterEach(() => process.off('unhandledRejection', noop));

  it('returns ok on a 204 success', async () => {
    post.mockResolvedValue(undefined);
    await expect(postRootComment(prRef)).resolves.toEqual({ ok: true });
  });

  it('preserves a KNOWN server error code (with message + postedCommentId)', async () => {
    post.mockRejectedValue(
      new FakeApiError(409, {
        code: 'already-posted-body-mismatch',
        message: 'edited after post',
        postedCommentId: 42,
      }),
    );
    await expect(postRootComment(prRef)).resolves.toEqual({
      ok: false,
      code: 'already-posted-body-mismatch',
      message: 'edited after post',
      postedCommentId: 42,
    });
  });

  it('does NOT launder an UNKNOWN server code into the union — falls back to github-network-error, message still surfaced', async () => {
    post.mockRejectedValue(
      new FakeApiError(400, { code: 'totally-new-future-code', message: 'from a newer server' }),
    );
    const result = await postRootComment(prRef);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // The unknown code is not in the allowlist, so it must be replaced — never cast
      // through as a fake member that a downstream exhaustive switch would mis-bucket.
      expect(KNOWN_POST_ROOT_COMMENT_ERROR_CODES as readonly string[]).not.toContain(
        'totally-new-future-code',
      );
      expect(result.code).toBe('github-network-error');
      // ...but the raw server message is preserved so the unknown code isn't silent.
      expect(result.message).toBe('from a newer server');
    }
  });

  it('maps a non-ApiError throw to github-network-error', async () => {
    post.mockRejectedValue(new TypeError('network down'));
    const result = await postRootComment(prRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github-network-error');
  });
});
