import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, type Location } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { AppearanceSync } from './components/AppearanceSync';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { CheatsheetProvider, Cheatsheet } from './components/Cheatsheet';
import { StreamHealthSnackbar } from './components/StreamHealthSnackbar';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { LoadingScreen } from './components/LoadingScreen';
import { SetupPage } from './pages/SetupPage';
import { WelcomePage } from './pages/WelcomePage';
import { InboxPage } from './pages/InboxPage';
import { PrTabHost } from './components/PrDetail/PrTabHost';
import { isSettingsPath } from './hooks/useEffectiveLocation';
import { SettingsModalRoutes } from './components/Settings/SettingsModalRoutes';
import { HelpModalRoutes } from './components/Help/HelpModalRoutes';
import { useAuth } from './hooks/useAuth';
import { EventStreamProvider } from './hooks/useEventSource';
import { apiClient } from './api/client';
import { OpenTabsProvider } from './contexts/OpenTabsContext';
import { PreferencesProvider } from './contexts/PreferencesContext';
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
  // #212: unauthed users split by whether they've ever connected. A true first
  // run (!hasToken) gets the welcome screen; a token-rejected re-auth session
  // (hasToken true) goes straight to the /setup token form — never re-onboarded.
  const unauthedTarget = authState.hasToken ? '/setup' : '/welcome';

  // The chrome (Routes, PrTabHost, strip) renders against this location. When a
  // Settings or Help modal is open the live URL is /settings/* or /help, but we
  // keep the chrome pinned to the underlying page behind the scrim —
  // backgroundLocation if the trigger supplied one, else a synthetic background
  // for a cold deep-link. Non-modal paths render against the live location.
  // NOTE: this const must live AFTER unauthedTarget because the /help synthetic
  // is auth-aware (first-run → unauthedTarget, authed → Inbox).
  const backgroundLocation =
    (location.state as { backgroundLocation?: Location } | null)?.backgroundLocation ??
    (isSettingsPath(location.pathname)
      ? ({ pathname: '/' } as Location)
      : location.pathname === '/help'
        ? ({ pathname: isAuthed ? '/' : unauthedTarget } as Location)
        : location);

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
          {/* #134: the chrome Routes render against backgroundLocation so an open
              Settings modal (live URL /settings/*) doesn't tear down the PR/inbox
              behind the scrim. The /settings PAGE route is gone — Settings is now
              the SettingsModalRoutes modal rendered below the shell. */}
          <Routes location={backgroundLocation}>
            {/* #212: the welcome screen renders ONLY for a true first run
                (!hasToken). A token-bearing user who somehow lands here is sent
                onward — authed → Inbox, rejected-token re-auth → /setup. */}
            <Route
              path="/welcome"
              element={
                authState.hasToken ? (
                  // hasToken is true in this arm, so unauthedTarget === '/setup' —
                  // referencing it (not a literal) keeps every redirect target
                  // sourced from the one `unauthedTarget` definition.
                  <Navigate to={isAuthed ? '/' : unauthedTarget} replace />
                ) : (
                  <WelcomePage />
                )
              }
            />
            <Route path="/setup" element={<SetupPage />} />
            <Route
              path="/"
              element={isAuthed ? <InboxPage /> : <Navigate to={unauthedTarget} replace />}
            />
            {/* PR-detail views no longer live in the route table. The /pr route
                renders null; the persistent PrTabHost below renders one
                keep-alive PrDetailView per open tab and shows the one matching
                the current /pr path. This is what lets a PR view survive
                navigating away and back with its sub-tab + scroll state intact. */}
            <Route
              path="/pr/:owner/:repo/:number/*"
              element={isAuthed ? null : <Navigate to={unauthedTarget} replace />}
            />
            <Route path="*" element={<Navigate to={isAuthed ? '/' : unauthedTarget} replace />} />
          </Routes>
          {isAuthed && <PrTabHost />}
        </div>
      </div>
      <SettingsModalRoutes isAuthed={isAuthed} unauthedTarget={unauthedTarget} />
      <HelpModalRoutes isAuthed={isAuthed} unauthedTarget={unauthedTarget} />
      <AskAiDrawer />
      <DrawerEffects />
      <TabSignals />
      <ToastContainer />
      <StreamHealthSnackbar />
      <Cheatsheet />
    </>
  );

  return (
    <ErrorBoundary>
      <ToastProvider>
        <CheatsheetProvider>
          <OpenTabsProvider>
            <AskAiDrawerProvider>
              {/* #143: one shared preferences store for the whole app. Mounted
                  OUTSIDE the isAuthed?EventStreamProvider conditional so it
                  covers both branches — AppearanceSync (inside `tree`) is the
                  sole unauthed consumer. Consequence: it can't call
                  useEventSource() directly (it's above EventStreamProvider); a
                  future SSE-driven invalidation would use a window-event bridge,
                  cf. OpenTabsContext. */}
              <PreferencesProvider>
                {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
              </PreferencesProvider>
            </AskAiDrawerProvider>
          </OpenTabsProvider>
        </CheatsheetProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
