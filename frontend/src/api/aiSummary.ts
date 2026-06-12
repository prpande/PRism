import { apiClient } from './client';
import type { AiSummaryResult, PrReference, PrSummary } from './types';

// Shared mapping for both the summary GET and the regenerate POST: a parsed body → 'ok',
// 204/undefined → 'absent', any throw (non-2xx incl. 503, or network failure) → 'error'.
// 204 never throws — apiClient returns undefined, mapped to 'absent' above.
async function resolveSummary(
  call: () => Promise<PrSummary | undefined>,
): Promise<AiSummaryResult> {
  try {
    const result = await call();
    return result ? { kind: 'ok', summary: result } : { kind: 'absent' };
  } catch {
    return { kind: 'error' };
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
