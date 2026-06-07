import { Routes, Route, useNavigate, useLocation, type Location } from 'react-router-dom';
import { HelpModal } from './HelpModal';

export interface HelpModalRoutesProps {
  isAuthed: boolean;
  // Where to send an unauthenticated user when they close the modal.
  // App passes unauthedTarget ('/welcome' for first run, '/setup' for re-auth).
  unauthedTarget: string;
}

export function HelpModalRoutes({ isAuthed, unauthedTarget }: HelpModalRoutesProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  const close = () => {
    // replace:true drops the /help entry from history so Back doesn't reopen the modal.
    // Resolve to bg (from the link's state) or fall back to the appropriate landing page.
    navigate(bg ?? (isAuthed ? '/' : unauthedTarget), { replace: true });
  };

  // The page Help is open over: the opener's backgroundLocation, else the same
  // synthetic App uses for a cold /help deep-link (Inbox authed; the unauthed
  // landing otherwise). Forwarded to the Settings link so it preserves context.
  const effectiveBackground: Location =
    bg ?? ({ pathname: isAuthed ? '/' : unauthedTarget } as Location);

  // Focus-restore fallback for a cold deep-link (no opener): the landmark of the
  // page actually behind the scrim. isAuthed=false splits into first-run
  // (/welcome → welcome-card) vs token-rejected re-auth (/setup → setup-card).
  const fallbackSelector = isAuthed
    ? '[data-testid="inbox-page"]'
    : unauthedTarget === '/setup'
      ? '[data-testid="setup-card"]'
      : '[data-testid="welcome-card"]';

  return (
    <Routes>
      <Route
        path="/help"
        element={
          <HelpModal
            onClose={close}
            authed={isAuthed}
            restoreFocusFallbackSelector={fallbackSelector}
            settingsBackground={effectiveBackground}
          />
        }
      />
    </Routes>
  );
}
