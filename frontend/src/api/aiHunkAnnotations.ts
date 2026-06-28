// frontend/src/api/aiHunkAnnotations.ts
import { apiClient } from './client';
import type { PrReference, HunkAnnotation } from './types';

export async function getAiHunkAnnotations(
  prRef: PrReference,
  signal?: AbortSignal,
): Promise<HunkAnnotation[] | null> {
  const result = await apiClient.get<HunkAnnotation[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/hunk-annotations`,
    { signal },
  );
  return result ?? null;
}
