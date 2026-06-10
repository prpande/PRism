import { apiClient } from './client';
import type { ActivityResponse } from './types';

export function getActivity(): Promise<ActivityResponse> {
  return apiClient.get<ActivityResponse>('/api/activity');
}
