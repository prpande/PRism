import { usePrRefEventSubscriber } from './usePrRefEventSubscriber';
import type { PrReference } from '../api/types';

export interface UseRootCommentPostedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports the PR-root draft was successfully posted as a
  // GitHub issue comment. Caller typically calls usePrDetail.reload() so the
  // posted comment appears in the conversation and the local draft clears.
  onPosted: () => void;
}

// Subscribes to 'root-comment-posted' SSE events, filtering by prRef so
// a multi-PR layout cannot receive another PR's root-comment notification.
export function useRootCommentPostedSubscriber({
  prRef,
  onPosted,
}: UseRootCommentPostedSubscriberOptions): void {
  usePrRefEventSubscriber('root-comment-posted', prRef, onPosted);
}
