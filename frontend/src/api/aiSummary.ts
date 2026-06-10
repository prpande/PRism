import { apiClient, ApiError } from './client';
import type { AiSummaryResult, PrReference, PrSummary } from './types';

export async function getAiSummary(prRef: PrReference): Promise<PrSummary | null> {
  // 204 No Content (Noop summarizer) round-trips as undefined; coerce to null
  // so the consuming hook has a clean { PrSummary | null } discriminator.
  const result = await apiClient.get<PrSummary | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/summary`,
  );
  return result ?? null;
}

export async function getAiSummaryResult(prRef: PrReference): Promise<AiSummaryResult> {
  try {
    const result = await apiClient.get<PrSummary | undefined>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/summary`,
    );
    return result ? { kind: 'ok', summary: result } : { kind: 'absent' };
  } catch (e) {
    // Any non-2xx (incl. 503) or network failure → error. 204 never throws (returns undefined above).
    void (e instanceof ApiError);
    return { kind: 'error' };
  }
}
