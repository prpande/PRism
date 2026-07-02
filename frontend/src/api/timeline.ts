import { apiClient } from './client';
import type { PrReference, TimelinePage } from './types';

export function getTimelinePage(
  prRef: PrReference,
  cursor?: string | null,
  signal?: AbortSignal,
): Promise<TimelinePage> {
  const q = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
  return apiClient.get<TimelinePage>(
    `/api/pr/${prRef.owner}/${prRef.repo}/${prRef.number}/timeline${q}`,
    { signal },
  );
}
