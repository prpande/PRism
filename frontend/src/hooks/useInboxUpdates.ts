import { useEffect, useState } from 'react';
import { openEventStream } from '../api/events';

export function useInboxUpdates() {
  const [hasUpdate, setHasUpdate] = useState(false);
  const [summary, setSummary] = useState('');

  useEffect(() => {
    const close = openEventStream({
      onInboxUpdated: (e) => {
        setHasUpdate(true);
        setSummary(`${e.newOrUpdatedPrCount} new updates`);
      },
    });
    return close;
  }, []);

  const dismiss = () => {
    setHasUpdate(false);
    setSummary('');
  };
  return { hasUpdate, summary, dismiss };
}
