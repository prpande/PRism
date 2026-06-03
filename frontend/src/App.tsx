import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { AppearanceSync } from './components/AppearanceSync';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { CheatsheetProvider, Cheatsheet } from './components/Cheatsheet';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { LoadingScreen } from './components/LoadingScreen';
import { SetupPage } from './pages/SetupPage';
import { InboxPage } from './pages/InboxPage';
import { PrDetailPage } from './pages/PrDetailPage';
import { SettingsPage } from './pages/SettingsPage';
import { OverviewTab } from './components/PrDetail/OverviewTab/OverviewTab';
import { FilesTab } from './components/PrDetail/FilesTab/FilesTab';
import { DraftsTabRoute } from './components/PrDetail/DraftsTab/DraftsTabRoute';
import { useAuth } from './hooks/useAuth';
import { EventStreamProvider } from './hooks/useEventSource';
import { apiClient } from './api/client';
import { OpenTabsProvider } from './contexts/OpenTabsContext';
import { AskAiDrawerProvider } from './contexts/AskAiDrawerContext';
import { AskAiDrawer } from './components/AskAiDrawer/AskAiDrawer';
import { DrawerEffects } from './components/AskAiDrawer/DrawerEffects';
import { PrTabStrip } from './components/PrTabStrip/PrTabStrip';
import { useTabUnreadSignal } from './hooks/useTabUnreadSignal';

function TabSignals() {
  useTabUnreadSignal();
  return null;
}

export function App() {
  const { authState, error, refetch } = useAuth();
  const [authInvalidated, setAuthInvalidated] = useState(false);

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
    return <div role="alert">Failed to load auth state: {error.message}</div>;
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
        <Header hasToken={authState.hasToken} />
        <PrTabStrip />
        <div data-app-scroll>
          <Routes>
            <Route path="/setup" element={<SetupPage />} />
            <Route
              path="/settings"
              element={isAuthed ? <SettingsPage /> : <Navigate to="/setup" replace />}
            />
            <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
            <Route
              path="/pr/:owner/:repo/:number"
              element={isAuthed ? <PrDetailPage /> : <Navigate to="/setup" replace />}
            >
              <Route index element={<OverviewTab />} />
              <Route path="files/*" element={<FilesTab />} />
              <Route path="drafts" element={<DraftsTabRoute />} />
            </Route>
            <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
          </Routes>
        </div>
      </div>
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
