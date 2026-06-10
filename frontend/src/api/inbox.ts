import { apiClient } from './client';
import type { InboxResponse, ParsePrUrlResponse } from './types';

export const inboxApi = {
  get: () => apiClient.get<InboxResponse>('/api/inbox'),
  parsePrUrl: (url: string) =>
    apiClient.post<ParsePrUrlResponse>('/api/inbox/parse-pr-url', { url }),
  // #311 — force an immediate backend GitHub re-poll. Empty 200 on success (client.ts
  // resolves empty bodies to undefined); throws ApiError on 503. The signal lets the
  // caller bound the held request with a timeout.
  refresh: (signal?: AbortSignal) =>
    apiClient.post<void>('/api/inbox/refresh', undefined, { signal }),
};
