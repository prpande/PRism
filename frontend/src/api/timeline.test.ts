import { describe, it, expect, vi, afterEach } from 'vitest';
import { getTimelinePage } from './timeline';

afterEach(() => vi.restoreAllMocks());

describe('getTimelinePage', () => {
  it('requests the timeline path and returns the page', async () => {
    const body = { events: [], olderCursor: 'CUR', hasOlder: true };
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const page = await getTimelinePage({ owner: 'acme', repo: 'api', number: 7 });

    expect(spy.mock.calls[0][0]).toContain('/api/pr/acme/api/7/timeline');
    expect(page.hasOlder).toBe(true);
  });

  it('encodes the cursor query param', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ events: [], olderCursor: null, hasOlder: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    await getTimelinePage({ owner: 'acme', repo: 'api', number: 7 }, 'a b/c');
    expect(spy.mock.calls[0][0]).toContain('cursor=a%20b%2Fc');
  });
});
