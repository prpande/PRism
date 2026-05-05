import { useCallback, useEffect, useState } from 'react';
import { apiClient } from '../api/client';
import type { AiCapabilities, CapabilitiesResponse } from '../api/types';

export function useCapabilities() {
  const [capabilities, setCapabilities] = useState<AiCapabilities | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const refetch = useCallback(async () => {
    try {
      const resp = await apiClient.get<CapabilitiesResponse>('/api/capabilities');
      setCapabilities(resp.ai);
    } catch (e) {
      setError(e as Error);
    }
  }, []);

  useEffect(() => {
    void refetch();
    const handler = () => {
      void refetch();
    };
    window.addEventListener('focus', handler);
    return () => window.removeEventListener('focus', handler);
  }, [refetch]);

  return { capabilities, error, refetch };
}
