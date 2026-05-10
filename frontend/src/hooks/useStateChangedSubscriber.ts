import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import { getTabId } from '../api/draft';
import type { PrReference } from '../api/types';

export interface UseStateChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a state change for the current PR
  // originating from a different tab. Caller typically calls
  // useDraftSession.refetch().
  onSessionChange: () => void;
  // Fired (alongside onSessionChange) when fieldsTouched includes
  // 'last-seen-comment-id' — the inbox badge for this PR may now be stale.
  // Per addendum A7.
  onInboxBadgeInvalidation?: () => void;
}

// Subscribes to 'state-changed' SSE events, filtering by:
// - sourceTabId === current tab id (suppresses own-tab refetch noise per
//   spec § 5.7);
// - prRef matches the canonical "owner/repo/number" string of the supplied
//   PR (avoids cross-PR refetches when the user has multiple PR pages
//   mounted, which the PoC technically doesn't but which is cheap to honor).
export function useStateChangedSubscriber({
  prRef,
  onSessionChange,
  onInboxBadgeInvalidation,
}: UseStateChangedSubscriberOptions): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = `${prRef.owner}/${prRef.repo}/${prRef.number}`;
    return stream.on('state-changed', (event) => {
      if (event.sourceTabId === getTabId()) return;
      if (event.prRef !== prRefStr) return;
      onSessionChange();
      if (event.fieldsTouched.includes('last-seen-comment-id')) {
        onInboxBadgeInvalidation?.();
      }
    });
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onSessionChange, onInboxBadgeInvalidation]);
}
