import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { jsonResponse } from './helpers/http';
import {
  discardAllDrafts,
  discardForeignPendingReview,
  discardOwnPendingReview,
  resumeForeignPendingReview,
  submitReview,
  SubmitConflictError,
} from '../src/api/submit';
import { __resetTabIdForTest } from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const PR_PATH = '/api/pr/octocat/hello/42';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  __resetTabIdForTest();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Quiet the auth-rejected event the api client dispatches on 401.
  vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('submitReview', () => {
  it('POSTs the kebab-case verdict to /submit and returns the parsed outcome', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: 'started' }, 200));
    const result = await submitReview(ref, 'comment');
    expect(result.outcome).toBe('started');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ verdict: 'comment' });
  });

  it('POSTs request-changes as kebab-case (the single canonical wire form)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ outcome: 'started' }, 200));
    await submitReview(ref, 'request-changes');
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ verdict: 'request-changes' });
  });

  it('throws SubmitConflictError carrying the code on 409', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'submit-in-progress', message: 'A submit is already running.' }, 409),
    );
    await expect(submitReview(ref, 'approve')).rejects.toMatchObject({
      name: 'SubmitConflictError',
      code: 'submit-in-progress',
    });
  });

  it('throws SubmitConflictError on a 4xx { code } body (e.g. stale-drafts)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'stale-drafts', message: '...' }, 400));
    await expect(submitReview(ref, 'approve')).rejects.toBeInstanceOf(SubmitConflictError);
  });

  it('rethrows the raw error when the body has no code field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500));
    await expect(submitReview(ref, 'approve')).rejects.not.toBeInstanceOf(SubmitConflictError);
  });
});

describe('resumeForeignPendingReview', () => {
  it('returns the Snapshot B payload on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          pullRequestReviewId: 'PRR_x',
          commitOid: 'abc',
          createdAt: '2026-05-11T10:00:00Z',
          threadCount: 2,
          replyCount: 1,
          threads: [
            {
              id: 't1',
              filePath: 'src/Foo.cs',
              lineNumber: 42,
              side: 'RIGHT',
              isResolved: false,
              body: 'b',
              replies: [],
            },
          ],
        },
        200,
      ),
    );
    const result = await resumeForeignPendingReview(ref, 'PRR_x');
    expect(result.threadCount).toBe(2);
    expect(result.threads).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit/foreign-pending-review/resume`);
    expect(JSON.parse(init.body as string)).toEqual({ pullRequestReviewId: 'PRR_x' });
  });

  it('throws SubmitConflictError(pending-review-state-changed) on 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'pending-review-state-changed' }, 409));
    await expect(resumeForeignPendingReview(ref, 'PRR_x')).rejects.toMatchObject({
      code: 'pending-review-state-changed',
    });
  });
});

describe('discardForeignPendingReview', () => {
  it('POSTs the review id and resolves on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(discardForeignPendingReview(ref, 'PRR_x')).resolves.toBeUndefined();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit/foreign-pending-review/discard`);
  });

  it('throws SubmitConflictError(delete-failed) on 502', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ code: 'delete-failed' }, 502));
    await expect(discardForeignPendingReview(ref, 'PRR_x')).rejects.toMatchObject({
      code: 'delete-failed',
    });
  });
});

describe('discardAllDrafts', () => {
  it('POSTs to /drafts/discard-all with an empty body and resolves on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 200));
    await expect(discardAllDrafts(ref)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/drafts/discard-all`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});

describe('discardOwnPendingReview', () => {
  it('returns { ok: true } on 204', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const result = await discardOwnPendingReview(ref);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit/discard`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('maps 401 to { ok: false, code: unauthorized }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'unauthorized',
          message: 'Subscribe to this PR before discarding.',
        },
        401,
      ),
    );
    const result = await discardOwnPendingReview(ref);
    expect(result).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Subscribe to this PR before discarding.',
    });
  });

  it('maps 502 github-forbidden to { ok: false, code: github-forbidden }', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ code: 'github-forbidden', message: 'GitHub returned 403.' }, 502),
    );
    const result = await discardOwnPendingReview(ref);
    expect(result).toEqual({
      ok: false,
      code: 'github-forbidden',
      message: 'GitHub returned 403.',
    });
  });

  it('maps 504 pipeline-cancellation-timeout to that code', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'pipeline-cancellation-timeout',
          message: 'The in-flight submit pipeline did not release within the allowed window.',
        },
        504,
      ),
    );
    const result = await discardOwnPendingReview(ref);
    expect(result).toEqual({
      ok: false,
      code: 'pipeline-cancellation-timeout',
      message: 'The in-flight submit pipeline did not release within the allowed window.',
    });
  });

  it('maps a thrown network error (non-ApiError) to github-network-error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await discardOwnPendingReview(ref);
    expect(result).toMatchObject({
      ok: false,
      code: 'github-network-error',
    });
    expect(typeof (result as { message: string }).message).toBe('string');
  });
});
