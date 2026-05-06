import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useInbox } from '../src/hooks/useInbox';
import { ApiError } from '../src/api/client';

vi.mock('../src/api/inbox', () => ({
  inboxApi: { get: vi.fn() },
}));

import { inboxApi } from '../src/api/inbox';

const sampleInbox = {
  sections: [],
  enrichments: {},
  lastRefreshedAt: '2026-01-01T00:00:00Z',
  tokenScopeFooterEnabled: false,
};

describe('useInbox', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 503 twice then resolves with data', async () => {
    vi.mocked(inboxApi.get)
      .mockRejectedValueOnce(new ApiError(503, null, { type: '/inbox/initializing' }))
      .mockRejectedValueOnce(new ApiError(503, null, { type: '/inbox/initializing' }))
      .mockResolvedValueOnce(sampleInbox as never);

    const { result } = renderHook(() => useInbox());

    // Advance through all retry delays using act to flush React state updates
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.data).toEqual(sampleInbox);
    expect(inboxApi.get).toHaveBeenCalledTimes(3);
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });

  it('bails on 401 without retry', async () => {
    vi.mocked(inboxApi.get).mockRejectedValueOnce(new ApiError(401, null, {}));

    const { result } = renderHook(() => useInbox());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(401);
    expect(inboxApi.get).toHaveBeenCalledOnce();
    expect(result.current.isLoading).toBe(false);
  });

  it('surfaces error after 3 consecutive 503s', async () => {
    vi.mocked(inboxApi.get).mockRejectedValue(new ApiError(503, null, {}));

    const { result } = renderHook(() => useInbox());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.error).toBeInstanceOf(ApiError);
    expect((result.current.error as ApiError).status).toBe(503);
    expect(inboxApi.get).toHaveBeenCalledTimes(3);
    expect(result.current.isLoading).toBe(false);
  });

  it('resolves immediately on first success (no retry needed)', async () => {
    vi.mocked(inboxApi.get).mockResolvedValueOnce(sampleInbox as never);

    const { result } = renderHook(() => useInbox());

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(result.current.data).toEqual(sampleInbox);
    expect(inboxApi.get).toHaveBeenCalledOnce();
    expect(result.current.error).toBeNull();
    expect(result.current.isLoading).toBe(false);
  });
});
