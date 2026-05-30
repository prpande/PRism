import { useEffect, useRef } from 'react';
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
  // Ref mirror — reassigned every render so the SSE callback below always
  // reads the current pathname without forcing the effect to re-bind on
  // route change. Matches the pattern used in OpenTabsContext.tsx for the
  // same closure-staleness avoidance.
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;

  useEffect(() => {
    if (!events) return;
    const off = events.on('pr-updated', (payload) => {
      const activeKey = activeKeyFromPathname(pathnameRef.current);
      if (payload.prRef === activeKey) return;
      markUnread(payload.prRef);
    });
    return off;
  }, [events, markUnread]);
}
