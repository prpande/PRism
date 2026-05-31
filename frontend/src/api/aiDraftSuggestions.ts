// frontend/src/api/aiDraftSuggestions.ts
import { apiClient } from './client';
import type { PrReference, DraftSuggestion } from './types';

export async function getAiDraftSuggestions(prRef: PrReference): Promise<DraftSuggestion[] | null> {
  const result = await apiClient.get<DraftSuggestion[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/draft-suggestions`,
  );
  return result ?? null;
}
