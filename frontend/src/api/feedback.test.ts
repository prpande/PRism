import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { post, FakeApiError } = vi.hoisted(() => {
  const post = vi.fn();
  class FakeApiError extends Error {
    status: number;
    constructor(status: number) {
      super(`status ${status}`);
      this.status = status;
    }
  }
  return { post, FakeApiError };
});
vi.mock('./client', () => ({ apiClient: { post }, ApiError: FakeApiError }));

import { submitFeedback } from './feedback';

const req = {
  category: 'Bug' as const,
  summary: 's',
  details: 'd',
  routePattern: '/',
  platform: 'browser',
};

// Suppress Vitest's unhandledRejection tracking for tests that intentionally
// reject promises caught inside submitFeedback's try/catch. mockRejectedValue
// creates a rejected promise that is briefly "unhandled" (one microtask tick)
// before submitFeedback's await+catch consumes it. Adding a second listener
// causes Vitest to skip its own unhandledRejection handler (see vitest init.js:
// "if there is another listener, assume that it's handled by user code").
const noop = () => {};

describe('submitFeedback', () => {
  beforeEach(() => {
    post.mockReset();
    process.on('unhandledRejection', noop);
  });
  afterEach(() => process.off('unhandledRejection', noop));

  it('returns created on 201', async () => {
    post.mockResolvedValue({ issueNumber: 9, htmlUrl: 'https://x/9' });
    await expect(submitFeedback(req)).resolves.toEqual({
      outcome: 'created',
      issueNumber: 9,
      htmlUrl: 'https://x/9',
    });
  });

  it('maps a 422 to cannot-create', async () => {
    post.mockRejectedValue(new FakeApiError(422));
    await expect(submitFeedback(req)).resolves.toEqual({ outcome: 'cannot-create' });
  });

  it('rethrows other errors (5xx/network)', async () => {
    post.mockRejectedValue(new FakeApiError(500));
    await expect(submitFeedback(req)).rejects.toBeInstanceOf(FakeApiError);
  });
});
