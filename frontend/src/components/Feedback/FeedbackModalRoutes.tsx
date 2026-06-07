import { Routes, Route, useNavigate, useLocation, type Location } from 'react-router-dom';
import { FeedbackModal } from './FeedbackModal';

export interface FeedbackModalRoutesProps {
  isAuthed: boolean;
  // Where to send an unauthenticated user when they close the modal.
  // App passes unauthedTarget ('/welcome' for first run, '/setup' for re-auth).
  unauthedTarget: string;
  // authState.host — forwarded to FeedbackModal to gate API vs link-only.
  host: string;
}

export function FeedbackModalRoutes({ isAuthed, unauthedTarget, host }: FeedbackModalRoutesProps) {
  const navigate = useNavigate();
  const location = useLocation();

  const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;

  const close = () => {
    // replace:true drops the /feedback entry from history so Back doesn't reopen the modal.
    // Resolve to bg (from the link's state) or fall back to the appropriate landing page.
    navigate(bg ?? (isAuthed ? '/' : unauthedTarget), { replace: true });
  };

  // The page feedback is open over: the opener's backgroundLocation, else the same
  // synthetic App uses for a cold /feedback deep-link (Inbox authed; the unauthed
  // landing otherwise).
  //
  // NOTE: Current triggers (/welcome "Send feedback" and Help section) are static routes
  // so pathname equals the matched pattern. A future PR-detail trigger must pass the
  // matched route pattern (e.g. '/pr/:owner/:repo/:number') via
  // `state={{ backgroundLocation: location, routePattern: match.pattern.path }}`
  // and read it here — a plain pathname like '/pr/foo/bar/42' would be misleading
  // context in the filed issue.
  const effectiveBackground: Location =
    bg ?? ({ pathname: isAuthed ? '/' : unauthedTarget } as Location);
  const routePattern = effectiveBackground.pathname;

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
        path="/feedback"
        element={
          <FeedbackModal
            onClose={close}
            authed={isAuthed}
            host={host}
            routePattern={routePattern}
            restoreFocusFallbackSelector={fallbackSelector}
          />
        }
      />
    </Routes>
  );
}
