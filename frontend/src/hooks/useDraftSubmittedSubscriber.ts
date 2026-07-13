import { usePrRefEventSubscriber } from './usePrRefEventSubscriber';
import type { PrReference } from '../api/types';

export interface UseDraftSubmittedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a review was submitted (full success, after the
  // server-side draft clear). Caller typically calls usePrDetail.reload() so the
  // just-posted threads + Overview comment surface, and useDraftSession.refetch()
  // so the submitted drafts clear from their composers — without a manual reload (#392).
  onSubmitted: () => void;
}

// Subscribes to 'draft-submitted' SSE events, filtering by prRef (exact string match) so
// a multi-PR layout cannot react to another PR's submit.
export function useDraftSubmittedSubscriber({
  prRef,
  onSubmitted,
}: UseDraftSubmittedSubscriberOptions): void {
  usePrRefEventSubscriber('draft-submitted', prRef, onSubmitted);
}
