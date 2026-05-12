import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  discardAllDrafts,
  discardForeignPendingReview,
  resumeForeignPendingReview,
  submitReview,
  SubmitConflictError,
  verdictToSubmitWire,
} from '../src/api/submit';
import { __resetTabIdForTest } from '../src/api/draft';
import type { PrReference } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const PR_PATH = '/api/pr/octocat/hello/42';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

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

describe('verdictToSubmitWire', () => {
  it('maps kebab DraftVerdict to PascalCase submit Verdict', () => {
    expect(verdictToSubmitWire('approve')).toBe('Approve');
    expect(verdictToSubmitWire('request-changes')).toBe('RequestChanges');
    expect(verdictToSubmitWire('comment')).toBe('Comment');
  });
});

describe('submitReview', () => {
  it('POSTs the PascalCase verdict to /submit and returns the parsed outcome', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { outcome: 'started' }));
    const result = await submitReview(ref, 'Comment');
    expect(result.outcome).toBe('started');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({ verdict: 'Comment' });
  });

  it('throws SubmitConflictError carrying the code on 409', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(409, { code: 'submit-in-progress', message: 'A submit is already running.' }),
    );
    await expect(submitReview(ref, 'Approve')).rejects.toMatchObject({
      name: 'SubmitConflictError',
      code: 'submit-in-progress',
    });
  });

  it('throws SubmitConflictError on a 4xx { code } body (e.g. stale-drafts)', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(400, { code: 'stale-drafts', message: '...' }));
    await expect(submitReview(ref, 'Approve')).rejects.toBeInstanceOf(SubmitConflictError);
  });

  it('rethrows the raw error when the body has no code field', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(500, { error: 'boom' }));
    await expect(submitReview(ref, 'Approve')).rejects.not.toBeInstanceOf(SubmitConflictError);
  });
});

describe('resumeForeignPendingReview', () => {
  it('returns the Snapshot B payload on 200', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(200, {
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
      }),
    );
    const result = await resumeForeignPendingReview(ref, 'PRR_x');
    expect(result.threadCount).toBe(2);
    expect(result.threads).toHaveLength(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit/foreign-pending-review/resume`);
    expect(JSON.parse(init.body as string)).toEqual({ pullRequestReviewId: 'PRR_x' });
  });

  it('throws SubmitConflictError(pending-review-state-changed) on 409', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(409, { code: 'pending-review-state-changed' }));
    await expect(resumeForeignPendingReview(ref, 'PRR_x')).rejects.toMatchObject({
      code: 'pending-review-state-changed',
    });
  });
});

describe('discardForeignPendingReview', () => {
  it('POSTs the review id and resolves on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(discardForeignPendingReview(ref, 'PRR_x')).resolves.toBeUndefined();
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/submit/foreign-pending-review/discard`);
  });

  it('throws SubmitConflictError(delete-failed) on 502', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(502, { code: 'delete-failed' }));
    await expect(discardForeignPendingReview(ref, 'PRR_x')).rejects.toMatchObject({
      code: 'delete-failed',
    });
  });
});

describe('discardAllDrafts', () => {
  it('POSTs to /drafts/discard-all with an empty body and resolves on 200', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200, {}));
    await expect(discardAllDrafts(ref)).resolves.toBeUndefined();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/drafts/discard-all`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });
});
