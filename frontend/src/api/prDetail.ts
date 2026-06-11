import { apiClient } from './client';
import type { PrDetailDto, PrReference } from './types';

export function getPrDetail(prRef: PrReference): Promise<PrDetailDto> {
  return apiClient.get<PrDetailDto>(`/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`);
}

// #344 — force an immediate backend GitHub re-read of this PR (bypasses the head-SHA-keyed
// snapshot cache). Empty 200 on success; throws ApiError on 404/503. The signal bounds the
// held request with a client timeout. Mirrors inboxApi.refresh.
export function refreshPrDetail(prRef: PrReference, signal?: AbortSignal): Promise<void> {
  return apiClient.post<void>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/refresh`,
    undefined,
    { signal },
  );
}
