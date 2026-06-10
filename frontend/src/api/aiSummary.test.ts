import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAiSummaryResult } from './aiSummary';
import { ApiError } from './client';
import type { PrSummary } from './types';

const { getMock } = vi.hoisted(() => ({
  getMock: vi.fn<[string], Promise<PrSummary | undefined>>(),
}));

vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return { ...actual, apiClient: { get: getMock } };
});

const pr = { owner: 'o', repo: 'r', number: 1 };

describe('getAiSummaryResult', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps 200 to ok', async () => {
    getMock.mockResolvedValue({ body: 'b', category: 'fix' });
    expect(await getAiSummaryResult(pr)).toEqual({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
  });

  it('maps 204 (undefined) to absent', async () => {
    getMock.mockResolvedValue(undefined);
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'absent' });
  });

  it('maps 503 to error', async () => {
    getMock.mockRejectedValue(new ApiError(503, null, null));
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'error' });
  });

  it('maps network error to error', async () => {
    getMock.mockRejectedValue(new Error('network'));
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'error' });
  });
});
