// frontend/src/api/aiFileFocus.ts
import { apiClient } from './client';
import type { PrReference, FileFocusResult } from './types';

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
