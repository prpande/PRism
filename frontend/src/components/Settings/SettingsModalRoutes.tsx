import { Routes, Route, Navigate, useNavigate, useLocation, type Location } from 'react-router-dom';
import { SettingsModal } from './SettingsModal';
import { SettingsLayout } from './SettingsLayout';
import { AppearancePane } from './panes/AppearancePane';
import { InboxPane } from './panes/InboxPane';
import { GitHubConnectionPane } from './panes/GitHubConnectionPane';
import { SystemPane } from './panes/SystemPane';

export interface SettingsModalRoutesProps {
  isAuthed: boolean;
}

// Redirect that FORWARDS the current entry's state. react-router's <Navigate>
// drops location.state by default, which would strip backgroundLocation on a
// bare /settings hop and snap the chrome behind the scrim to the synthetic
// Inbox (re-firing the #180 refetch the whole design prevents). Spec §3.4.
function RedirectToAppearance() {
  const location = useLocation();
  return <Navigate to="/settings/appearance" replace state={location.state} />;
}

export function SettingsModalRoutes({ isAuthed }: SettingsModalRoutesProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const close = () => {
    const bg = (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation;
    navigate(bg ?? '/'); // cold deep-link → Inbox; never navigate(-1)
  };

  // Spec §3.4 auth guard, on the /settings parent: an unauthenticated cold
  // deep-link redirects to /setup before any pane (or the modal) renders.
  if (!isAuthed) {
    return (
      <Routes>
        <Route path="/settings/*" element={<Navigate to="/setup" replace />} />
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
