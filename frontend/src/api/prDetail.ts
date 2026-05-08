import { apiClient } from './client';
import type { PrDetailDto, PrReference } from './types';

export function getPrDetail(prRef: PrReference): Promise<PrDetailDto> {
  return apiClient.get<PrDetailDto>(`/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}`);
}
