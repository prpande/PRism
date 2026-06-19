import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAiSummaryResult, regenerateAiSummary } from './aiSummary';
import { ApiError } from './client';
import type { PrSummary } from './types';

const { getMock, postMock } = vi.hoisted(() => ({
  getMock: vi.fn<(path: string) => Promise<PrSummary | undefined>>(),
  postMock: vi.fn<(path: string) => Promise<PrSummary | undefined>>(),
}));

vi.mock('./client', async (orig) => {
  const actual = await orig<typeof import('./client')>();
  return { ...actual, apiClient: { get: getMock, post: postMock } };
});

const pr = { owner: 'o', repo: 'r', number: 1 };

describe('getAiSummaryResult', () => {
  beforeEach(() => vi.clearAllMocks());

  it('maps 200 to ok and targets the canonical endpoint path', async () => {
    getMock.mockResolvedValue({ body: 'b', category: 'fix' });
    expect(await getAiSummaryResult(pr)).toEqual({
      kind: 'ok',
      summary: { body: 'b', category: 'fix' },
    });
    expect(getMock).toHaveBeenCalledWith('/api/pr/o/r/1/ai/summary');
  });

  it('maps 204 (undefined) to absent', async () => {
    getMock.mockResolvedValue(undefined);
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'absent' });
  });

  it('maps 503 to error', async () => {
    getMock.mockRejectedValue(new ApiError(503, null, null));
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'error', reason: 'provider-error' });
  });

  it('maps network error to error', async () => {
    getMock.mockRejectedValue(new Error('network'));
    expect(await getAiSummaryResult(pr)).toEqual({ kind: 'error', reason: 'provider-error' });
  });
});

describe('regenerateAiSummary', () => {
  it('POSTs the regenerate route and maps 200 to ok', async () => {
    postMock.mockResolvedValue({ body: 'fresh', category: 'fix' });
    expect(await regenerateAiSummary(pr)).toEqual({
      kind: 'ok',
      summary: { body: 'fresh', category: 'fix' },
    });
    expect(postMock).toHaveBeenCalledWith('/api/pr/o/r/1/ai/summary/regenerate');
  });

  it('maps 204 (undefined) to absent', async () => {
    postMock.mockResolvedValue(undefined);
    expect(await regenerateAiSummary(pr)).toEqual({ kind: 'absent' });
  });

  it('maps 503 to error', async () => {
    postMock.mockRejectedValue(new ApiError(503, null, null));
    expect(await regenerateAiSummary(pr)).toEqual({ kind: 'error', reason: 'provider-error' });
  });
});
