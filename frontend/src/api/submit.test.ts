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

import {
  discardOwnPendingReview,
  KNOWN_DISCARD_OWN_PENDING_REVIEW_ERROR_CODES,
  KNOWN_SUBMIT_ERROR_CODES,
  SubmitConflictError,
  submitErrorMessage,
} from './submit';

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

describe('submitErrorMessage (pure toast-copy map, extracted from PrHeader for #327)', () => {
  // Codes with fixed user-facing copy — the switch replaces the server message.
  const fixedCopy: Record<string, string> = {
    'head-sha-not-stamped':
      "Couldn't submit — the PR view hasn't been stamped yet. Reload the PR and try again.",
    'tab-id-missing':
      "Couldn't submit — this browser tab is in an unexpected state. Reload the tab and try again.",
    'head-sha-drift':
      "Couldn't submit — the PR's head commit changed since you last viewed it. Reload the PR.",
    unauthorized: "Couldn't submit — your subscription to this PR was lost. Reload the PR.",
    'no-session': "Couldn't submit — no draft session for this PR. Reload the PR.",
    'stale-drafts':
      "Couldn't submit — there are stale drafts. Resolve or override them in the Drafts tab first.",
    'verdict-needs-reconfirm': "Couldn't submit — re-confirm your verdict before submitting.",
    'no-content':
      "Couldn't submit — a Comment-verdict review needs at least one inline comment, reply, or summary.",
    'verdict-invalid': "Couldn't submit — verdict must be Approve, Request changes, or Comment.",
    'submit-in-progress':
      'A submit is already in flight for this PR. Wait for it to finish or refresh the page.',
  };
  // Known codes that intentionally fall through to the server-supplied message.
  const serverMessageCodes = ['pending-review-state-changed', 'delete-failed'];

  it('the test table covers every KnownSubmitErrorCode exactly once', () => {
    expect([...Object.keys(fixedCopy), ...serverMessageCodes].sort()).toEqual(
      [...KNOWN_SUBMIT_ERROR_CODES].sort(),
    );
  });

  it.each(Object.entries(fixedCopy))(
    'maps %s to its fixed toast copy (server message ignored)',
    (code, expected) => {
      expect(submitErrorMessage(new SubmitConflictError(code, 'server-sent detail'))).toBe(
        expected,
      );
    },
  );

  it.each(serverMessageCodes)('honours the server message for %s', (code) => {
    expect(submitErrorMessage(new SubmitConflictError(code, 'server-sent detail'))).toBe(
      'server-sent detail',
    );
  });

  it('falls through to the server message for an unknown (forward-compat) code', () => {
    expect(
      submitErrorMessage(new SubmitConflictError('brand-new-server-code', 'from a newer server')),
    ).toBe('from a newer server');
  });
});
