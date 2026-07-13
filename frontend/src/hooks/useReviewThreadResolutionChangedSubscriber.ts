import { usePrRefEventSubscriber } from './usePrRefEventSubscriber';
import type { PrReference } from '../api/types';

export interface UseReviewThreadResolutionChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a review-thread resolution change for this PR. Caller
  // (FilesTab) reloads PR detail so the thread's resolved state reflects the server.
  onChanged: () => void;
}

// Subscribes to 'review-thread-resolution-changed' SSE events, filtering by prRef.
export function useReviewThreadResolutionChangedSubscriber({
  prRef,
  onChanged,
}: UseReviewThreadResolutionChangedSubscriberOptions): void {
  usePrRefEventSubscriber('review-thread-resolution-changed', prRef, onChanged);
}
