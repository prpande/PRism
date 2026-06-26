import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getCheckRuns, rerunCheck } from './checks';
import { apiClient } from './client';

describe('getCheckRuns', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('GETs the checks endpoint with the head sha', async () => {
    const spy = vi.spyOn(apiClient, 'get').mockResolvedValue({
      checks: [],
      headSha: 'abc',
      degraded: 'none',
    });
    const ctrl = new AbortController();
    const res = await getCheckRuns({ owner: 'o', repo: 'r', number: 1 }, 'abc', ctrl.signal);
    expect(spy).toHaveBeenCalledWith('/api/pr/o/r/1/checks?sha=abc', { signal: ctrl.signal });
    expect(res.headSha).toBe('abc');
  });
});

describe('rerunCheck', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs to the rerun route with the sha query param', async () => {
    const post = vi.spyOn(apiClient, 'post').mockResolvedValue({ outcome: 'accepted' });
    const ctrl = new AbortController();

    const res = await rerunCheck({ owner: 'o', repo: 'r', number: 7 }, 555, 'abc123', ctrl.signal);

    expect(res).toEqual({ outcome: 'accepted' });
    expect(post).toHaveBeenCalledWith('/api/pr/o/r/7/checks/555/rerun?sha=abc123', undefined, {
      signal: ctrl.signal,
    });
  });
});
