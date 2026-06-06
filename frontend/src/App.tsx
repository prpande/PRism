import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, type Location } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { AppearanceSync } from './components/AppearanceSync';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { CheatsheetProvider, Cheatsheet } from './components/Cheatsheet';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { LoadingScreen } from './components/LoadingScreen';
import { SetupPage } from './pages/SetupPage';
import { InboxPage } from './pages/InboxPage';
import { PrTabHost } from './components/PrDetail/PrTabHost';
import { isSettingsPath } from './hooks/useEffectiveLocation';
import { SettingsModalRoutes } from './components/Settings/SettingsModalRoutes';
import { useAuth } from './hooks/useAuth';
import { EventStreamProvider } from './hooks/useEventSource';
import { apiClient } from './api/client';
import { OpenTabsProvider } from './contexts/OpenTabsContext';
import { AskAiDrawerProvider } from './contexts/AskAiDrawerContext';
import { AskAiDrawer } from './components/AskAiDrawer/AskAiDrawer';
import { DrawerEffects } from './components/AskAiDrawer/DrawerEffects';
import { PrTabStrip } from './components/PrTabStrip/PrTabStrip';
import { useTabUnreadSignal } from './hooks/useTabUnreadSignal';
import { ErrorModal } from './components/ErrorModal';

function TabSignals() {
  useTabUnreadSignal();
  return null;
}

export function App() {
  const { authState, error, refetch } = useAuth();
  const [authInvalidated, setAuthInvalidated] = useState(false);
  const location = useLocation();
  // The chrome (Routes, PrTabHost, strip) renders against this location. When a
  // Settings modal is open the live URL is /settings/*, but we keep the chrome
  // pinned to the underlying PR/inbox behind the scrim — backgroundLocation if
  // the gear/SettingsLink supplied one, else a synthetic Inbox for a cold
  // deep-link. Non-settings paths render against the live location unchanged.
  const backgroundLocation =
    (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ??
    (isSettingsPath(location.pathname) ? ({ pathname: '/' } as Location) : location);

  useEffect(() => {
    const onRejected = () => setAuthInvalidated(true);
    const onRecovered = () => setAuthInvalidated(false);
    window.addEventListener('prism-auth-rejected', onRejected);
    window.addEventListener('prism-auth-recovered', onRecovered);
    return () => {
      window.removeEventListener('prism-auth-rejected', onRejected);
      window.removeEventListener('prism-auth-recovered', onRecovered);
    };
  }, []);

  if (authState === null && error) {
    return (
      <ErrorModal
        open
        title="Couldn't load auth state"
        message={error.message}
        actions={
          <button
            type="button"
            className="btn btn-primary"
            data-modal-role="primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        }
        onClose={() => {}}
      />
    );
  }
  if (authState === null) return <LoadingScreen />;

  if (authState.hostMismatch) {
    return (
      <HostChangeModal
        oldHost={authState.hostMismatch.old}
        newHost={authState.hostMismatch.new}
        onContinue={async () => {
          await apiClient.post('/api/auth/host-change-resolution', { resolution: 'continue' });
          void refetch();
        }}
        onRevert={async () => {
          await apiClient.post('/api/auth/host-change-resolution', { resolution: 'revert' });
        }}
      />
    );
  }

  const isAuthed = authState.hasToken && !authInvalidated;

  const tree: ReactNode = (
    <>
      <AppearanceSync />
      {/* data-app-shell + data-app-scroll let the desktop shell scroll page
          content in a region BELOW the navbar (so the scrollbar starts under the
          navbar, not beside it). In the browser these are unstyled passthrough
          divs and the document scrolls as before. */}
      <div data-app-shell>
        <Header isAuthed={isAuthed} />
        <PrTabStrip />
        <div data-app-scroll>
          <Routes location={backgroundLocation}>
            <Route path="/setup" element={<SetupPage />} />
            <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
            {/* PR-detail views no longer live in the route table. The /pr route
                renders null; the persistent PrTabHost below renders one
                keep-alive PrDetailView per open tab and shows the one matching
                the current /pr path. This is what lets a PR view survive
                navigating away and back with its sub-tab + scroll state intact. */}
            <Route
              path="/pr/:owner/:repo/:number/*"
              element={isAuthed ? null : <Navigate to="/setup" replace />}
            />
            <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
          </Routes>
          {isAuthed && <PrTabHost />}
        </div>
      </div>
      <SettingsModalRoutes isAuthed={isAuthed} />
      <AskAiDrawer />
      <DrawerEffects />
      <TabSignals />
      <ToastContainer />
      <Cheatsheet />
    </>
  );

  return (
    <ErrorBoundary>
      <ToastProvider>
        <CheatsheetProvider>
          <OpenTabsProvider>
            <AskAiDrawerProvider>
              {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
            </AskAiDrawerProvider>
          </OpenTabsProvider>
        </CheatsheetProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
