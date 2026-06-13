import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseSingleCommentPostedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a single inline comment/reply was posted for this PR.
  // Caller typically calls usePrDetail.reload() so the new thread surfaces with its
  // ReplyComposer and the optimistic placeholder de-dupes away.
  onPosted: () => void;
}

// Subscribes to 'single-comment-posted' SSE events, filtering by prRef so a multi-PR
// layout cannot receive another PR's notification. Mirrors useRootCommentPostedSubscriber.
export function useSingleCommentPostedSubscriber({
  prRef,
  onPosted,
}: UseSingleCommentPostedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('single-comment-posted', (event) => {
      if (event.prRef !== prRefStr) return;
      onPosted();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onPosted]);
}
