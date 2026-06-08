import { useLocation, type Location } from 'react-router-dom';

export type EffectiveLocation = Pick<Location, 'pathname'>;

const SYNTHETIC_INBOX: EffectiveLocation = { pathname: '/' };

export function isSettingsPath(pathname: string): boolean {
  return pathname === '/settings' || pathname.startsWith('/settings/');
}

// The app location that is *really* in view. When a Settings, Help, or Feedback
// modal is open the live URL is /settings/*, /help, or /feedback, but chrome
// mounted outside <Routes> (PrTabHost, PrTabStrip, the AskAi drawer, the unread
// signal) must keep tracking the underlying PR/inbox behind the scrim.
// backgroundLocation (set by the gear / Help / Feedback triggers and propagated by
// SettingsLink) carries it; a cold deep-link has none, so we synthesize the Inbox
// background. /help and /feedback get the same treatment as /settings — without it,
// a cold deep-link would drop the active PR-tab highlight and close the AskAi drawer.
export function useEffectiveLocation(): EffectiveLocation {
  const location = useLocation();
  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
  if (bg) return bg;
  if (
    isSettingsPath(location.pathname) ||
    location.pathname === '/help' ||
    location.pathname === '/feedback'
  )
    return SYNTHETIC_INBOX;
  return location;
}
