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

  const close = () => {
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
    // replace:true drops the /help entry from history so Back doesn't reopen the modal.
    // Resolve to bg (from the link's state) or fall back to the appropriate landing page.
    navigate(bg ?? (isAuthed ? '/' : unauthedTarget), { replace: true });
  };

  return (
    <Routes>
      <Route
        path="/help"
        element={
          <HelpModal
            onClose={close}
            authed={isAuthed}
            restoreFocusFallbackSelector={
              isAuthed ? '[data-testid="inbox-page"]' : '[data-testid="welcome-card"]'
            }
          />
        }
      />
    </Routes>
  );
}
