import { describe, expect, it, vi, beforeEach } from 'vitest';
import { getCheckRuns } from './checks';
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
