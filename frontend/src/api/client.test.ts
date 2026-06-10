import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient } from './client';

describe('apiClient prism-request-failed', () => {
  beforeEach(() => {
    document.cookie = 'prism-session=test';
  });

  it('dispatches prism-request-failed on a failed response', async () => {
    const spy = vi.fn();
    window.addEventListener('prism-request-failed', spy);
    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('boom', { status: 500 }) as Response,
    );
    await expect(apiClient.get('/api/anything')).rejects.toBeTruthy();
    expect(spy).toHaveBeenCalled();
    window.removeEventListener('prism-request-failed', spy);
  });
});
