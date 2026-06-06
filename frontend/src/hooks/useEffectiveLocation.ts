import { useLocation, type Location } from 'react-router-dom';

export type EffectiveLocation = Pick<Location, 'pathname'>;

const SYNTHETIC_INBOX: EffectiveLocation = { pathname: '/' };

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

// The app location that is *really* in view. When a Settings modal is open the
// live URL is /settings/*, but chrome mounted outside <Routes> (PrTabHost,
// PrTabStrip, the AskAi drawer, the unread signal) must keep tracking the
// underlying PR/inbox behind the scrim. backgroundLocation (set by the gear and
// propagated by SettingsLink) carries it; a cold deep-link has none, so we
// synthesize the Inbox background.
export function useEffectiveLocation(): EffectiveLocation {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  if (bg) return bg;
  if (isSettingsPath(location.pathname)) return SYNTHETIC_INBOX;
  return location;
}
