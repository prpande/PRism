import { describe, it, expect, vi, beforeEach } from 'vitest';
import { postComment } from '../../src/api/comment';
import { apiClient, ApiError } from '../../src/api/client';

vi.mock('../../src/api/client', async (orig) => {
  const actual = await orig<typeof import('../../src/api/client')>();
  return { ...actual, apiClient: { ...actual.apiClient, post: vi.fn() } };
});
const prRef = { owner: 'o', repo: 'r', number: 1 };

describe('postComment', () => {
  beforeEach(() => vi.clearAllMocks());
  it('posts and returns ok with postedCommentId', async () => {
    vi.mocked(apiClient.post).mockResolvedValue({ postedCommentId: 4242 });
    const res = await postComment(prRef, 'draft-1');
    expect(apiClient.post).toHaveBeenCalledWith('/api/pr/o/r/1/comment/post', { draftId: 'draft-1' }, expect.anything());
    expect(res).toEqual({ ok: true, postedCommentId: 4242 });
  });
  it('maps an ApiError to a no-throw failure union', async () => {
    vi.mocked(apiClient.post).mockRejectedValue(new ApiError(502, null, { code: 'github-network-error', message: "Couldn't reach GitHub. Try again." }));
    const res = await postComment(prRef, 'draft-1');
    expect(res).toMatchObject({ ok: false, status: 502, code: 'github-network-error' });
  });
});
