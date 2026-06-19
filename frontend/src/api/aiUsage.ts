import { apiClient } from './client';
import type { AiUsageReport, AiUsageWindow } from './types';

// The endpoint always returns 200 with a (possibly empty) report — never 204. A network/5xx
// failure throws (ApiError or a fetch error); the pane catches it and shows the error state.
export function getAiUsage(usageWindow: AiUsageWindow): Promise<AiUsageReport> {
  return apiClient.get<AiUsageReport>(`/api/ai/usage?window=${usageWindow}`);
}
