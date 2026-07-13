import { usePrRefEventSubscriber } from './usePrRefEventSubscriber';
import type { PrReference } from '../api/types';

export interface UseSingleCommentPostedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a single inline comment/reply was posted for this PR.
  // Caller typically calls usePrDetail.reload() so the new thread surfaces with its
  // ReplyComposer and the optimistic placeholder de-dupes away.
  onPosted: () => void;
}

// Subscribes to 'single-comment-posted' SSE events, filtering by prRef so a multi-PR
// layout cannot receive another PR's notification.
export function useSingleCommentPostedSubscriber({
  prRef,
  onPosted,
}: UseSingleCommentPostedSubscriberOptions): void {
  usePrRefEventSubscriber('single-comment-posted', prRef, onPosted);
}
