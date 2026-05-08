import { apiClient } from './client';
import type { PrReference } from './types';

export interface FileViewedRequest {
  path: string;
  headSha: string;
  viewed: boolean;
}

export function postFileViewed(prRef: PrReference, body: FileViewedRequest): Promise<void> {
  return apiClient.post<void>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/files/viewed`,
    body,
  );
}
