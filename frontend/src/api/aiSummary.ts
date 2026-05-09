import { apiClient } from './client';
import type { PrReference, PrSummary } from './types';

export async function getAiSummary(prRef: PrReference): Promise<PrSummary | null> {
  // 204 No Content (Noop summarizer) round-trips as undefined; coerce to null
  // so the consuming hook has a clean { PrSummary | null } discriminator.
  const result = await apiClient.get<PrSummary | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/summary`,
  );
  return result ?? null;
}
