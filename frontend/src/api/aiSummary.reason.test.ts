import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getAiSummaryResult } from './aiSummary';
import { ApiError } from './client';

vi.mock('./client', async () => {
  const actual = await vi.importActual<typeof import('./client')>('./client');
  return { ...actual, apiClient: { get: vi.fn(), post: vi.fn() } };
});
import { apiClient } from './client';

describe('getAiSummaryResult reason', () => {
  beforeEach(() => vi.clearAllMocks());

  it('surfaces reason "timeout" from a 503 body', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(503, null, { reason: 'timeout' }));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'error', reason: 'timeout' });
  });

  it('defaults to "provider-error" when the 503 body has no reason', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(503, null, {}));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'error', reason: 'provider-error' });
  });

  it('maps 401 to auth (unchanged)', async () => {
    vi.mocked(apiClient.get).mockRejectedValueOnce(new ApiError(401, null, null));
    const r = await getAiSummaryResult({ owner: 'o', repo: 'r', number: 1 });
    expect(r).toEqual({ kind: 'auth' });
  });
});
