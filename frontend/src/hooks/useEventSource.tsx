import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { openEventStream, type EventStreamHandle } from '../api/events';

const EventStreamContext = createContext<EventStreamHandle | null>(null);

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [handle, setHandle] = useState<EventStreamHandle | null>(null);

  useEffect(() => {
    const h = openEventStream();
    setHandle(h);
    return () => {
      h.close();
    };
  }, []);

  return <EventStreamContext.Provider value={handle}>{children}</EventStreamContext.Provider>;
}

export function useEventSource(): EventStreamHandle | null {
  return useContext(EventStreamContext);
}
