import { useEffect, useState } from 'react';
import { useEventSource } from './useEventSource';
import type { PrReference } from '../api/types';

// Returns false until the first `pr-updated` SSE event for the supplied PR
// arrives, then true. Used to gate the Mark-all-read button on the Overview
// tab — the active-PR poller (PR3) must populate the per-PR
// `IActivePrCache.HighestIssueCommentId` snapshot before the cursor advance
// has anything to advance to. The first `pr-updated` after subscription is
// the cheapest signal that the snapshot is hydrated.
//
// Resets to false on `prRef` change so navigating between PRs re-gates the
// button until the new PR's first poll lands.
//
// SSE plumbing mirrors `useStateChangedSubscriber` (PR4): subscribes via
// `useEventSource()` (the `EventStreamProvider` context) and filters events
// by the canonical `${owner}/${repo}/${number}` string.
export function useFirstActivePrPollComplete(prRef: PrReference | null): boolean {
  const stream = useEventSource();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setReady(false);
    if (!stream || !prRef) return;
    const prRefStr = `${prRef.owner}/${prRef.repo}/${prRef.number}`;
    return stream.on('pr-updated', (event) => {
      if (event.prRef !== prRefStr) return;
      setReady(true);
    });
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number]);

  return ready;
}
