import { getTabId } from './tabId';
import type { AiFailureReason } from './types';

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

// #496: extract the AI-failure reason from a 503 body ({ reason }). Defaults to 'provider-error' for
// a missing/unknown reason or a non-ApiError throw (network failure), so callers never branch on null.
export function readFailureReason(body: unknown): AiFailureReason {
  if (body && typeof body === 'object' && 'reason' in body) {
    const r = (body as { reason?: unknown }).reason;
    if (r === 'timeout' || r === 'provider-error') return r;
  }
  return 'provider-error';
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
  // Optional AbortSignal forwarded to fetch — lets fire-and-forget callers
  // (usePrDetail's mark-viewed) cancel an in-flight request when the React
  // effect cleans up, avoiding a slow A-stamp landing after a fast B-stamp.
  signal?: AbortSignal;
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
  // X-PRism-Tab-Id is required on all writes (spec § 3) — submit/mark-viewed/reload reject
  // missing or out-of-allowlist values with a distinct 422 tab-id-missing. Attaching it on
  // every request (GET included) is harmless on read paths and saves every call site from
  // remembering to opt in. getTabId() reads sessionStorage on call (not at module load), so
  // the tab id is minted lazily on the FIRST request rather than at import time.
  headers['X-PRism-Tab-Id'] = getTabId();
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const resp = await fetch(path, {
    method,
    headers: Object.keys(headers).length ? headers : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options?.signal,
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
    // #312: cue useAuth to re-read the credential-health latch. Suppress it when
    // the failing request IS /api/auth/state — the listener's only job is to refetch
    // that endpoint, so re-dispatching on its own failure would schedule a needless
    // refetch every debounce window.
    if (!path.startsWith('/api/auth/state')) {
      window.dispatchEvent(new CustomEvent('prism-request-failed'));
    }
    throw new ApiError(resp.status, requestId, parsed);
  }
  if (resp.status === 204) return undefined as unknown as T;
  // 200 with an empty response body is valid — PrDraftEndpoints' PatchOutcome.Applied
  // path returns Results.Ok() (no body) for patches that don't carry an AssignedIdResponse
  // (overrideStale, confirmVerdict, markAllRead, update/delete-draft). Without this guard,
  // `resp.json()` throws SyntaxError on empty bodies; sendPatch catches it as a "network"
  // failure and the caller's onMutated() never fires, leaving the FE session stale until
  // the next page reload or non-own-tab SSE event. The real-flow stale-OID spec is the
  // regression net for this — see docs/specs/2026-05-11-s5-submit-pipeline-deferrals.md.
  const text = await resp.text();
  if (text === '') return undefined as unknown as T;
  return JSON.parse(text) as T;
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
