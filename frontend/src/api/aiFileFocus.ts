// frontend/src/api/aiFileFocus.ts
import { apiClient } from './client';
import type { PrReference, FileFocus } from './types';

// 204 No Content (NoopFileFocusRanker) round-trips as undefined; coerce to
// null so the consuming hook has a clean { FileFocus[] | null } discriminator.
export async function getAiFileFocus(prRef: PrReference): Promise<FileFocus[] | null> {
  const result = await apiClient.get<FileFocus[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
  );
  return result ?? null;
}
