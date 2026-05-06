import { useCallback, useEffect, useState } from 'react';
import { inboxApi } from '../api/inbox';
import { ApiError } from '../api/client';
import type { InboxResponse } from '../api/types';

const RETRY_DELAYS_MS = [0, 500, 1500];

export function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    let lastError: unknown = null;
    for (const delay of RETRY_DELAYS_MS) {
      if (delay > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }
      try {
        setData(await inboxApi.get());
        setError(null);
        setIsLoading(false);
        return;
      } catch (e) {
        lastError = e;
        // Only retry on 503 (backend initializing); all other errors fail fast.
        if (!(e instanceof ApiError) || e.status !== 503) break;
      }
    }
    setError(lastError);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, isLoading, reload };
}
