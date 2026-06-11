import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { postRootComment } from '../src/api/rootComment';
import type { PrReference } from '../src/api/types';
import { jsonResponse } from './helpers/http';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };
const PR_PATH = '/api/pr/octocat/hello/42';

function emptyResponse(status: number): Response {
  return new Response(null, { status });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // Quiet the auth-rejected event the api client dispatches on 401.
  vi.spyOn(window, 'dispatchEvent').mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('postRootComment', () => {
  it('returns { ok: true } on 204', async () => {
    fetchMock.mockResolvedValueOnce(emptyResponse(204));
    const result = await postRootComment(ref);
    expect(result).toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${PR_PATH}/root-comment/post`);
    expect(init.method).toBe('POST');
    expect(init.body).toBeUndefined();
  });

  it('maps 409 already-posted-body-mismatch with postedCommentId payload', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'already-posted-body-mismatch',
          message: 'The draft body was edited after it was first posted.',
          postedCommentId: 12345,
        },
        409,
      ),
    );
    const result = await postRootComment(ref);
    expect(result).toEqual({
      ok: false,
      code: 'already-posted-body-mismatch',
      message: 'The draft body was edited after it was first posted.',
      postedCommentId: 12345,
    });
  });

  it('maps 502 github-forbidden error', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'github-forbidden',
          message: 'GitHub returned 403 Forbidden.',
        },
        502,
      ),
    );
    const result = await postRootComment(ref);
    expect(result).toEqual({
      ok: false,
      code: 'github-forbidden',
      message: 'GitHub returned 403 Forbidden.',
      postedCommentId: undefined,
    });
  });

  it('maps 401 to unauthorized', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        {
          code: 'unauthorized',
          message: 'Subscribe to this PR before posting a comment.',
        },
        401,
      ),
    );
    const result = await postRootComment(ref);
    expect(result).toEqual({
      ok: false,
      code: 'unauthorized',
      message: 'Subscribe to this PR before posting a comment.',
      postedCommentId: undefined,
    });
  });

  it('maps a thrown network error (non-ApiError) to github-network-error', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    const result = await postRootComment(ref);
    expect(result).toMatchObject({
      ok: false,
      code: 'github-network-error',
    });
    expect(typeof (result as { message: string }).message).toBe('string');
  });
});
