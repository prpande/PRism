import { apiClient, ApiError } from './client';

export interface FeedbackRequest {
  category: 'Bug' | 'Idea' | 'Other';
  summary: string;
  details: string;
  routePattern: string;
  platform: string;
}

export type FeedbackResult =
  | { outcome: 'created'; issueNumber: number; htmlUrl: string }
  | { outcome: 'cannot-create' };

// 201 → created; 422 (CannotCreate) → caller falls back to the prefilled link;
// anything else (5xx/network) rethrows for the retry path.
export async function submitFeedback(req: FeedbackRequest): Promise<FeedbackResult> {
  try {
    const res = await apiClient.post<{ issueNumber: number; htmlUrl: string }>(
      '/api/feedback',
      req,
    );
    return { outcome: 'created', issueNumber: res.issueNumber, htmlUrl: res.htmlUrl };
  } catch (e) {
    if (e instanceof ApiError && e.status === 422) return { outcome: 'cannot-create' };
    throw e;
  }
}
