import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { prRefKey, type PrReference } from '../api/types';

export interface UseLifecycleChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a PR lifecycle change for this PR. Caller (PrDetailView)
  // clears the transition latch then reloads PR detail so the panel swaps button sets.
  onChanged: () => void;
}

// Subscribes to 'pr-lifecycle-changed' SSE events, filtering by prRef. Mirrors
// useSingleCommentPostedSubscriber. #566 reusable foundation (#571 reuses the shape).
export function useLifecycleChangedSubscriber({
  prRef,
  onChanged,
}: UseLifecycleChangedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on('pr-lifecycle-changed', (event) => {
      if (event.prRef !== prRefStr) return;
      onChanged();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onChanged]);
}
