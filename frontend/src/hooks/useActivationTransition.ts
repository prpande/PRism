import { useEffect, useRef } from 'react';

// Fires `onActivate` on the false->true transition of `active`, and never on
// first mount (even if mounted already-active). Used so a kept-alive
// PrDetailView refetches + clears unread only when the user switches TO it,
// not on every render while active and not when it first mounts.
export function useActivationTransition(active: boolean, onActivate: () => void): void {
  const prev = useRef<boolean | null>(null);
  // Keep the latest callback without re-running the effect on every render.
  const cbRef = useRef(onActivate);
  cbRef.current = onActivate;

  useEffect(() => {
    const wasActive = prev.current;
    prev.current = active;
    // null = first mount: record state, never fire.
    if (wasActive === false && active === true) {
      cbRef.current();
    }
  }, [active]);
}
