import { apiClient } from './client';
import type { DiffDto, PrReference } from './types';

export function getDiff(prRef: PrReference, range: string): Promise<DiffDto> {
  return apiClient.get<DiffDto>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/diff?range=${encodeURIComponent(range)}`,
  );
}

export function getDiffByCommits(prRef: PrReference, commits: string[]): Promise<DiffDto> {
  const encoded = commits.map((c) => encodeURIComponent(c)).join(',');
  return apiClient.get<DiffDto>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/diff?commits=${encoded}`,
  );
}
