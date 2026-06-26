import { apiClient } from './client';
import type { ChecksResponse, PrReference, RerunResponse } from './types';

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

export function rerunCheck(
  prRef: PrReference,
  checkRunId: number,
  headSha: string,
  signal: AbortSignal,
): Promise<RerunResponse> {
  return apiClient.post<RerunResponse>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/checks/${checkRunId}/rerun?sha=${encodeURIComponent(headSha)}`,
    undefined,
    { signal },
  );
}
