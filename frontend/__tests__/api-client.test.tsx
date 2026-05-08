import { describe, it, expect, vi, afterEach } from 'vitest';
import { apiClient, ApiError } from '../src/api/client';

describe('apiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('dispatches prism-auth-rejected on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const handler = vi.fn();
    window.addEventListener('prism-auth-rejected', handler);
    try {
      await expect(apiClient.get('/api/inbox')).rejects.toBeInstanceOf(ApiError);
      expect(handler).toHaveBeenCalledOnce();
    } finally {
      window.removeEventListener('prism-auth-rejected', handler);
    }
  });

  it('does not dispatch prism-auth-rejected on non-401 errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"boom"}', {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const handler = vi.fn();
    window.addEventListener('prism-auth-rejected', handler);
    try {
      await expect(apiClient.get('/api/inbox')).rejects.toBeInstanceOf(ApiError);
      expect(handler).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('prism-auth-rejected', handler);
    }
  });

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

  it('DELETE returns undefined on 204', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 })) as unknown as typeof fetch;
    const result = await apiClient.delete('/api/events/subscriptions?prRef=foo/bar/1');
    expect(result).toBeUndefined();
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'DELETE' });
  });

  it('DELETE throws ApiError on non-2xx', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"not found"}', {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch;
    await expect(
      apiClient.delete('/api/events/subscriptions?prRef=missing/repo/1'),
    ).rejects.toBeInstanceOf(ApiError);
  });
});

describe('apiClient — X-PRism-Session header echo', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockCookie(value: string) {
    vi.spyOn(document, 'cookie', 'get').mockReturnValue(value);
  }

  it('echoes prism-session cookie value as X-PRism-Session header on GET', async () => {
    mockCookie('prism-session=tok-abc; theme=dark');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.get('/api/inbox');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PRism-Session')).toBe('tok-abc');
  });

  it('echoes session cookie on POST as well', async () => {
    mockCookie('prism-session=tok-xyz');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.post('/api/pr/foo/bar/1/mark-viewed', { headSha: 'abc' });
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PRism-Session')).toBe('tok-xyz');
  });

  it('echoes session cookie on DELETE as well', async () => {
    mockCookie('prism-session=tok-del');
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.delete('/api/events/subscriptions?prRef=foo/bar/1');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PRism-Session')).toBe('tok-del');
  });

  it('omits X-PRism-Session header when prism-session cookie is absent', async () => {
    mockCookie('theme=dark; accent=indigo');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.get('/api/inbox');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.has('X-PRism-Session')).toBe(false);
  });

  it('reads cookie fresh per request (handles cookie rotation)', async () => {
    const cookieSpy = vi.spyOn(document, 'cookie', 'get').mockReturnValue('prism-session=v1');
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
        ),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.get('/api/inbox');
    cookieSpy.mockReturnValue('prism-session=v2');
    await apiClient.get('/api/inbox');

    const init1 = fetchMock.mock.calls[0][1] as RequestInit;
    const init2 = fetchMock.mock.calls[1][1] as RequestInit;
    expect(new Headers(init1.headers).get('X-PRism-Session')).toBe('v1');
    expect(new Headers(init2.headers).get('X-PRism-Session')).toBe('v2');
  });

  it('URL-decodes the prism-session cookie value before echoing as X-PRism-Session', async () => {
    // ASP.NET's Response.Cookies.Append URL-encodes the value when it writes
    // Set-Cookie, so document.cookie surfaces the encoded form (e.g. base64 `+/=`
    // appear as `%2B`/`%2F`/`%3D`). SessionTokenMiddleware compares the header
    // bytes directly against the raw token, so the frontend must decode before
    // echoing — otherwise tokens containing escapable chars 401 on the header
    // path. (Cookie path still works because Request.Cookies decodes server-side.)
    mockCookie('prism-session=tok%2Bsigned%3Dvalue; other=foo');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.get('/api/inbox');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PRism-Session')).toBe('tok+signed=value');
  });

  it('falls back to the raw cookie value if decodeURIComponent throws', async () => {
    // decodeURIComponent throws on malformed escape sequences (e.g. lone `%`).
    // Falling back to the raw value is the conservative behavior — at worst
    // the cookie path takes over server-side; at best the raw value matches.
    mockCookie('prism-session=tok%ZZbad');
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }),
      );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await apiClient.get('/api/inbox');
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const headers = new Headers(init.headers);
    expect(headers.get('X-PRism-Session')).toBe('tok%ZZbad');
  });
});
