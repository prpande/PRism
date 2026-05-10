export class ApiError extends Error {
  readonly status: number;
  readonly requestId: string | null;
  readonly body: unknown;

  constructor(status: number, requestId: string | null, body: unknown) {
    super(`HTTP ${status}`);
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

function readSessionCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)prism-session=([^;]*)/);
  if (!match) return null;
  // ASP.NET's Response.Cookies.Append URL-encodes the cookie value (so base64
  // `+`/`/`/`=` arrive in document.cookie as `%2B`/`%2F`/`%3D`).
  // SessionTokenMiddleware compares X-PRism-Session bytes directly against the
  // raw token, so we decode before echoing — otherwise tokens with escapable
  // chars 401 on the header path. Fall back to the raw value if decodeURIComponent
  // throws on a malformed escape sequence.
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

export interface RequestOptions {
  // Caller-provided headers are baseline; standard headers (X-PRism-Session,
  // Content-Type) override on collision. Used by api/draft.ts to attach
  // X-PRism-Tab-Id without duplicating session-cookie logic.
  headers?: Record<string, string>;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  const headers: Record<string, string> = { ...options?.headers };
  const session = readSessionCookie();
  if (session !== null) headers['X-PRism-Session'] = session;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const resp = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const requestId = resp.headers.get('X-Request-Id');
  if (!resp.ok) {
    const text = await resp.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* ignore */
    }
    if (resp.status === 401) {
      window.dispatchEvent(new CustomEvent('prism-auth-rejected'));
    }
    throw new ApiError(resp.status, requestId, parsed);
  }
  if (resp.status === 204) return undefined as unknown as T;
  return (await resp.json()) as T;
}

export const apiClient = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('POST', path, body, options),
  put: <T>(path: string, body?: unknown, options?: RequestOptions) =>
    request<T>('PUT', path, body, options),
  delete: <T>(path: string, options?: RequestOptions) =>
    request<T>('DELETE', path, undefined, options),
};
