import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseDraftSubmittedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a review was submitted (full success, after the
  // server-side draft clear). Caller typically calls usePrDetail.reload() so the
  // just-posted threads + Overview comment surface, and useDraftSession.refetch()
  // so the submitted drafts clear from their composers — without a manual reload (#392).
  onSubmitted: () => void;
}

// Subscribes to 'draft-submitted' SSE events, filtering by prRef (exact string match) so
// a multi-PR layout cannot react to another PR's submit. Mirrors
// useRootCommentPostedSubscriber — the submit path is the same invalidate-and-reload class
// of refresh the root-comment-post path uses.
export function useDraftSubmittedSubscriber({
  prRef,
  onSubmitted,
}: UseDraftSubmittedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('draft-submitted', (event) => {
      if (event.prRef !== prRefStr) return;
      onSubmitted();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onSubmitted]);
}
