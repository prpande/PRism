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

import { discardOwnPendingReview, KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES } from './submit';

const prRef = { owner: 'acme', repo: 'api', number: 1 };
const noop = () => {};

describe('discardOwnPendingReview error-code handling (#330 — no cast-laundering)', () => {
  beforeEach(() => {
    post.mockReset();
    process.on('unhandledRejection', noop);
  });
  afterEach(() => process.off('unhandledRejection', noop));

  it('returns ok on a 204 success', async () => {
    post.mockResolvedValue(undefined);
    await expect(discardOwnPendingReview(prRef)).resolves.toEqual({ ok: true });
  });

  it('preserves a KNOWN server error code (with message)', async () => {
    post.mockRejectedValue(
      new FakeApiError(504, { code: 'pipeline-cancellation-timeout', message: 'lock held' }),
    );
    await expect(discardOwnPendingReview(prRef)).resolves.toEqual({
      ok: false,
      code: 'pipeline-cancellation-timeout',
      message: 'lock held',
    });
  });

  it('does NOT launder an UNKNOWN server code into the union — falls back to github-network-error, message still surfaced', async () => {
    post.mockRejectedValue(
      new FakeApiError(400, { code: 'brand-new-server-code', message: 'from a newer server' }),
    );
    const result = await discardOwnPendingReview(prRef);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES as readonly string[]).not.toContain(
        'brand-new-server-code',
      );
      expect(result.code).toBe('github-network-error');
      expect(result.message).toBe('from a newer server');
    }
  });

  it('maps a non-ApiError throw to github-network-error', async () => {
    post.mockRejectedValue(new TypeError('network down'));
    const result = await discardOwnPendingReview(prRef);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('github-network-error');
  });
});
