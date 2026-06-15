import { apiClient, ApiError, readFailureReason } from './client';
import type { AiSummaryResult, PrReference, PrSummary } from './types';

// Shared mapping for both the summary GET and the regenerate POST: a parsed body → 'ok',
// 204/undefined → 'absent', 401 → 'auth' (auth banner owns it; don't surface as failure),
// any other throw (non-2xx incl. 503, or network failure) → 'error'.
// 204 never throws — apiClient returns undefined, mapped to 'absent' above.
async function resolveSummary(
  call: () => Promise<PrSummary | undefined>,
): Promise<AiSummaryResult> {
  try {
    const result = await call();
    return result ? { kind: 'ok', summary: result } : { kind: 'absent' };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return { kind: 'auth' };
    return {
      kind: 'error',
      reason: err instanceof ApiError ? readFailureReason(err.body) : 'provider-error',
    };
  }
}

export function getAiSummaryResult(prRef: PrReference): Promise<AiSummaryResult> {
  return resolveSummary(() =>
    apiClient.get<PrSummary | undefined>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/summary`,
    ),
  );
}

export function regenerateAiSummary(prRef: PrReference): Promise<AiSummaryResult> {
  return resolveSummary(() =>
    apiClient.post<PrSummary | undefined>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/summary/regenerate`,
    ),
  );
}
