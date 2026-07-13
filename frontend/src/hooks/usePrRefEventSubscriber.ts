import { useEffect } from 'react';
import { useEventSource } from './useEventSource';
import type { EventPayloadByType } from '../api/events';
import { prRefKey, type PrReference } from '../api/types';

// The SSE event types whose payload carries a `prRef` string — the ones a
// per-PR subscriber can filter on. Excludes payloads like 'identity-changed'
// that have no prRef, so passing one is a compile error.
type PrRefEventType = {
  [K in keyof EventPayloadByType]: EventPayloadByType[K] extends { prRef: string } ? K : never;
}[keyof EventPayloadByType];

// Shared foundation for the per-event, prRef-filtered SSE subscriber hooks (#455).
// Subscribes to `eventType`, drops frames whose `prRef` isn't this PR's (so a
// multi-PR layout never cross-reacts), and invokes `onEvent` on a match. The named
// hooks in this directory are one-line wrappers over this — it collapses the
// useEffect / stream.on / prRef-filter boilerplate they used to each duplicate.
//
// NOT for 'state-changed': that subscriber additionally suppresses own-tab frames
// (sourceTabId) and branches on fieldsTouched, so it stays its own hook
// (see useStateChangedSubscriber).
export function usePrRefEventSubscriber<K extends PrRefEventType>(
  eventType: K,
  prRef: PrReference | null,
  onEvent: () => void,
): void {
  const stream = useEventSource();
  useEffect(() => {
    if (!stream || !prRef) return;
    const prRefStr = prRefKey(prRef);
    return stream.on(eventType, (event) => {
      if (event.prRef !== prRefStr) return;
      onEvent();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are prRef's stable primitive fields; the prRef object is a fresh literal each render (#331)
  }, [stream, prRef?.owner, prRef?.repo, prRef?.number, onEvent, eventType]);
}
