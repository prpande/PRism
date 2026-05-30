import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useEventSource } from './useEventSource';
import { useOpenTabs } from '../contexts/OpenTabsContext';

// Active-route check is done at signal time (not in a useEffect dep) so a
// route change does NOT re-mark an in-flight unread signal as unread — once
// the user is on a tab, any signal that arrives for it is considered "seen".
function activeKeyFromPathname(pathname: string): string | null {
  const m = pathname.match(/^\/pr\/([^/]+)\/([^/]+)\/(\d+)(?:\/|$)/);
  if (!m) return null;
  return `${m[1]}/${m[2]}/${m[3]}`;
}

export function useTabUnreadSignal(): void {
  const events = useEventSource();
  const { markUnread } = useOpenTabs();
  const { pathname } = useLocation();

  useEffect(() => {
    if (!events) return;
    const off = events.on('pr-updated', (payload) => {
      const activeKey = activeKeyFromPathname(pathname);
      if (payload.prRef === activeKey) return;
      markUnread(payload.prRef);
    });
    return off;
  }, [events, markUnread, pathname]);
}
