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
  return match ? match[1] : null;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
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
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
};
