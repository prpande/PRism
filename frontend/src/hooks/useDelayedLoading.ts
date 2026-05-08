import { useEffect, useRef, useState } from 'react';

const WAIT_MS = 100;
const HOLD_MS = 300;

export function useDelayedLoading(actualIsLoading: boolean): boolean {
  const [show, setShow] = useState(false);
  const showStartedAt = useRef<number | null>(null);

  useEffect(() => {
    if (actualIsLoading) {
      if (show) return;
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
