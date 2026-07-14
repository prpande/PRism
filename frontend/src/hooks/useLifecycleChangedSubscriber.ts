import { usePrRefEventSubscriber } from './usePrRefEventSubscriber';
import type { PrReference } from '../api/types';

export interface UseLifecycleChangedSubscriberOptions {
  prRef: PrReference | null;
  // Fired when the server reports a PR lifecycle change for this PR. Caller (PrDetailView)
  // clears the transition latch then reloads PR detail so the panel swaps button sets.
  onChanged: () => void;
}

// Subscribes to 'pr-lifecycle-changed' SSE events, filtering by prRef.
export function useLifecycleChangedSubscriber({
  prRef,
  onChanged,
}: UseLifecycleChangedSubscriberOptions): void {
  usePrRefEventSubscriber('pr-lifecycle-changed', prRef, onChanged);
}
