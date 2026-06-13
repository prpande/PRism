// frontend/src/api/aiFileFocus.ts
import { apiClient } from './client';
import type { PrReference, FileFocus, FileFocusResult } from './types';

// LEGACY (pre-#408 array body): still consumed by useAiFileFocus / FilesTab dots
// until Task 12 migrates them to the envelope. Do NOT remove until then.
// 204 No Content (NoopFileFocusRanker) round-trips as undefined; coerce to
// null so the consuming hook has a clean { FileFocus[] | null } discriminator.
export async function getAiFileFocus(prRef: PrReference): Promise<FileFocus[] | null> {
  const result = await apiClient.get<FileFocus[] | undefined>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
  );
  return result ?? null;
}

// Discriminated outcome so the hook can tell 204 (no-content) from a parsed body from a failure.
export type AiFileFocusOutcome =
  | { kind: 'ok'; result: FileFocusResult }
  | { kind: 'no-content' }
  | { kind: 'error' };

export async function getAiFileFocusResult(prRef: PrReference): Promise<AiFileFocusOutcome> {
  try {
    const result = await apiClient.get<FileFocusResult | undefined>(
      `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/ai/file-focus`,
    );
    // 204 → apiClient returns undefined.
    return result ? { kind: 'ok', result } : { kind: 'no-content' };
  } catch {
    return { kind: 'error' };
  }
}
