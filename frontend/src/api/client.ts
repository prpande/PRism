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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const resp = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
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
};
