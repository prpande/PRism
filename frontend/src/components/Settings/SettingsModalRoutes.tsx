import { Routes, Route, Navigate, useNavigate, useLocation, type Location } from 'react-router-dom';
import { SettingsModal } from './SettingsModal';
import { SettingsLayout } from './SettingsLayout';
import { AppearancePane } from './panes/AppearancePane';
import { InboxPane } from './panes/InboxPane';
import { GitHubConnectionPane } from './panes/GitHubConnectionPane';
import { SystemPane } from './panes/SystemPane';

export interface SettingsModalRoutesProps {
  isAuthed: boolean;
  // #212: where an unauthed cold deep-link to /settings/* is sent. App computes
  // this as the single source of truth — '/welcome' for a true first run
  // (!hasToken), '/setup' for a rejected-token re-auth session. The modal's
  // guard must use the same target as the chrome's, or the two <Navigate>s race
  // and an unauthed /settings deep-link leaks back to /setup (app.test.tsx:
  // "all four guard sites change together").
  unauthedTarget: string;
}

// Redirect that FORWARDS the current entry's state. react-router's <Navigate>
// drops location.state by default, which would strip backgroundLocation on a
// bare /settings hop and snap the chrome behind the scrim to the synthetic
// Inbox (re-firing the #180 refetch the whole design prevents). Spec §3.4.
function RedirectToAppearance() {
  const location = useLocation();
  return <Navigate to="/settings/appearance" replace state={location.state} />;
}

export function SettingsModalRoutes({ isAuthed, unauthedTarget }: SettingsModalRoutesProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => {
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
    // replace:true drops the /settings/* entry from history so Back doesn't
    // reopen the modal. Still never navigate(-1) — a cold deep-link has no
    // in-app entry to go back to, so we resolve to bg (or Inbox) explicitly.
    navigate(bg ?? '/', { replace: true });
  };

  // Spec §3.4 auth guard, on the /settings parent: an unauthenticated cold
  // deep-link redirects away before any pane (or the modal) renders. Target is
  // unauthedTarget (see prop docs) so it agrees with the chrome's own guard.
  if (!isAuthed) {
    return (
      <Routes>
        <Route path="/settings/*" element={<Navigate to={unauthedTarget} replace />} />
      </Routes>
    );
  }

  return (
    <Routes>
      <Route path="/settings" element={<RedirectToAppearance />} />
      <Route
        path="/settings/*"
        element={
          <SettingsModal onClose={close} restoreFocusFallbackSelector='[data-testid="inbox-page"]'>
            <SettingsLayout />
          </SettingsModal>
        }
      >
        <Route path="appearance" element={<AppearancePane />} />
        <Route path="inbox" element={<InboxPane />} />
        <Route path="github-connection" element={<GitHubConnectionPane />} />
        <Route path="system" element={<SystemPane />} />
        <Route path="*" element={<Navigate to="/settings/appearance" replace />} />
      </Route>
    </Routes>
  );
}
