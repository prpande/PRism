import { useCallback, useEffect, useState } from 'react';
import { inboxApi } from '../api/inbox';
import type { InboxResponse } from '../api/types';

export function useInbox() {
  const [data, setData] = useState<InboxResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [isLoading, setIsLoading] = useState(true);

  const reload = useCallback(async () => {
    setIsLoading(true);
    try {
      setData(await inboxApi.get());
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, isLoading, reload };
}
