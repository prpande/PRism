import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getAiSummary } from '../src/api/aiSummary';
import { apiClient } from '../src/api/client';
import type { PrReference, PrSummary } from '../src/api/types';

const ref: PrReference = { owner: 'octocat', repo: 'hello', number: 42 };

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getAiSummary', () => {
  it('returns null when the apiClient yields undefined (204 No Content path)', async () => {
    // apiClient.get returns undefined for 204 responses (see client.ts).
    // The helper coerces that to null so callers have a clean
    // PrSummary | null discriminator.
    vi.spyOn(apiClient, 'get').mockResolvedValue(undefined);
    const result = await getAiSummary(ref);
    expect(result).toBeNull();
  });

  it('returns the PrSummary verbatim when the apiClient yields a 200 body', async () => {
    const summary: PrSummary = { body: 'Refactor X.', category: 'Refactor' };
    vi.spyOn(apiClient, 'get').mockResolvedValue(summary);
    const result = await getAiSummary(ref);
    expect(result).toEqual(summary);
  });

  it('targets the canonical endpoint path', async () => {
    const spy = vi.spyOn(apiClient, 'get').mockResolvedValue(undefined);
    await getAiSummary(ref);
    expect(spy).toHaveBeenCalledWith('/api/pr/octocat/hello/42/ai/summary');
  });

  it('propagates rejections from the apiClient (caller hook decides how to handle)', async () => {
    vi.spyOn(apiClient, 'get').mockRejectedValue(new Error('network down'));
    await expect(getAiSummary(ref)).rejects.toThrow('network down');
  });
});
