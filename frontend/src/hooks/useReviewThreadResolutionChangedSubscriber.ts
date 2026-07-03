import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseReviewThreadResolutionChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a review-thread resolution change for this PR. Caller
  // (PrDetailView) reloads PR detail so the thread's resolved state reflects the server.
  onChanged: () => void;
}

// Subscribes to 'review-thread-resolution-changed' SSE events, filtering by prRef. Mirrors
// useLifecycleChangedSubscriber. #571 reuses the #566 shape.
export function useReviewThreadResolutionChangedSubscriber({
  prRef,
  onChanged,
}: UseReviewThreadResolutionChangedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('review-thread-resolution-changed', (event) => {
      if (event.prRef !== prRefStr) return;
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onChanged]);
}
