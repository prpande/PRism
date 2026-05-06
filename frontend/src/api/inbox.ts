import { apiClient } from './client';
import type { InboxResponse, ParsePrUrlResponse } from './types';

export const inboxApi = {
  get: () => apiClient.get<InboxResponse>('/api/inbox'),
  parsePrUrl: (url: string) =>
    apiClient.post<ParsePrUrlResponse>('/api/inbox/parse-pr-url', { url }),
};
