import { apiClient } from './client';

// Wire shape from PRism.Web/Endpoints/AuthDtos.cs:AuthReplaceResponse.
// `login` is nullable on the backend (?) record; the only path that produces a
// 200 with login=null is a defensive one (no account row yet, which the endpoint
// short-circuits before validation), so legitimate happy-path responses always
// carry a string. We keep the null option to match the wire contract exactly.
export interface ReplaceTokenResponse {
  ok: true;
  login: string | null;
  host: string;
  identityChanged: boolean;
}

// Wire shape from AuthReplaceError. Codes from PRism.Web/Endpoints/AuthEndpoints.cs:
//   - 400 invalid-json (non-object JSON root or parse failure)
//   - 400 pat-required (missing/empty pat field)
//   - 400 <lowercased AuthValidationError> (invalidtoken / insufficientscopes /
//     networkerror / dnserror / servererror — token rejected by GitHub returns
//     400 invalidtoken, NOT 401; the apiClient's 401 path dispatches
//     prism-auth-rejected for session-cookie rejection only)
//   - 409 submit-in-flight (prRef set, names the held PR)
// Frontend never reads `ok: false` directly because apiClient.post throws ApiError
// on non-2xx; the body is exposed via ApiError.body for the caller to map.
export interface ReplaceTokenError {
  ok: false;
  error: string;
  prRef?: string | null;
}

// POST /api/auth/replace (spec § 3.2.1). On success, returns identityChanged so
// the page can decide whether to surface the "drafts preserved; Node IDs cleared"
// toast. On 4xx, apiClient throws ApiError — caller pattern-matches on .body.
export async function replaceToken(pat: string): Promise<ReplaceTokenResponse> {
  return apiClient.post<ReplaceTokenResponse>('/api/auth/replace', { pat });
}
