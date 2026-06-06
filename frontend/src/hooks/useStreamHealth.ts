import { useEffect, useState } from 'react';
import { useEventSource } from './useEventSource';

export function useStreamHealth(): { healthy: boolean; retry: () => void } {
  const stream = useEventSource();
  const [healthy, setHealthy] = useState(() => (stream ? stream.streamHealthy() : true));

  useEffect(() => {
    if (!stream) {
      setHealthy(true);
      return;
    }
    setHealthy(stream.streamHealthy()); // sync to current value on (re)subscribe
    return stream.onHealthChange(setHealthy);
  }, [stream]);

  return { healthy, retry: () => stream?.forceReconnect() };
}
