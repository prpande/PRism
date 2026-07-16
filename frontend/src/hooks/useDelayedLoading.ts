import { useEffect, useRef, useState } from 'react';

const WAIT_MS = 100;
const HOLD_MS = 300;

export function useDelayedLoading(actualIsLoading: boolean): boolean {
  const [show, setShow] = useState(false);
  const showStartedAt = useRef<number | null>(null);
  // #145 — previous loading value, so a false→true edge is distinguishable from the effect
  // re-running on a `show` flip. A second cycle starting inside the hold window re-stamps the
  // hold anchor; without it, that cycle's completion inherits the first cycle's nearly-expired
  // window and hides prematurely.
  const wasLoadingRef = useRef(false);

  useEffect(() => {
    const isLoadingEdge = actualIsLoading && !wasLoadingRef.current;
    wasLoadingRef.current = actualIsLoading;
    if (actualIsLoading) {
      if (show) {
        if (isLoadingEdge) showStartedAt.current = Date.now();
        return;
      }
      const id = setTimeout(() => {
        showStartedAt.current = Date.now();
        setShow(true);
      }, WAIT_MS);
      return () => clearTimeout(id);
    }
    if (!show) return;
    const startedAt = showStartedAt.current ?? Date.now();
    const remaining = Math.max(0, HOLD_MS - (Date.now() - startedAt));
    const id = setTimeout(() => {
      showStartedAt.current = null;
      setShow(false);
    }, remaining);
    return () => clearTimeout(id);
  }, [actualIsLoading, show]);

  return show;
}
