import { useEffect, useState } from 'react';
import { useEventSource } from './useEventSource';

export function useInboxUpdates() {
  const stream = useEventSource();
  const [hasUpdate, setHasUpdate] = useState(false);
  const [summary, setSummary] = useState('');

  useEffect(() => {
    if (!stream) return;
    return stream.on('inbox-updated', (e) => {
      setHasUpdate(true);
      const n = e.newOrUpdatedPrCount;
      setSummary(`${n} new ${n === 1 ? 'update' : 'updates'}`);
    });
  }, [stream]);

  const dismiss = () => {
    setHasUpdate(false);
    setSummary('');
  };
  return { hasUpdate, summary, dismiss };
}
