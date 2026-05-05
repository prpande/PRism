import { describe, it, expect, vi } from 'vitest';
import { apiClient, ApiError } from '../src/api/client';

describe('apiClient', () => {
  it('attaches X-Request-Id from response to thrown ApiError', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response('{"error":"boom"}', {
          status: 500,
          headers: { 'X-Request-Id': 'abc123', 'Content-Type': 'application/problem+json' },
        }),
      ),
    ) as unknown as typeof fetch;
    await expect(apiClient.get('/api/health')).rejects.toMatchObject({
      requestId: 'abc123',
      status: 500,
    });
    await expect(apiClient.get('/api/health')).rejects.toBeInstanceOf(ApiError);
  });

  it('GET returns parsed JSON on 2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"port":5180}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    const result = await apiClient.get('/api/health');
    expect(result).toEqual({ port: 5180 });
  });
});
