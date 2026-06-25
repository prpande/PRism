import { apiClient } from './client';
import type { ChecksResponse, PrReference } from './types';

export function getCheckRuns(
  prRef: PrReference,
  headSha: string,
  signal: AbortSignal,
): Promise<ChecksResponse> {
  return apiClient.get<ChecksResponse>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/checks?sha=${encodeURIComponent(headSha)}`,
    { signal },
  );
}
