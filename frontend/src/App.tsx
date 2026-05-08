import { useEffect, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { SetupPage } from './pages/SetupPage';
import { InboxPage } from './pages/InboxPage';
import { PrDetailPage } from './pages/PrDetailPage';
import { OverviewTabPlaceholder } from './components/PrDetail/OverviewTab/OverviewTabPlaceholder';
import { FilesTabPlaceholder } from './components/PrDetail/FilesTab/FilesTabPlaceholder';
import { DraftsTabDisabled } from './components/PrDetail/DraftsTab/DraftsTabDisabled';
import { useAuth } from './hooks/useAuth';
import { EventStreamProvider } from './hooks/useEventSource';
import { apiClient } from './api/client';

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
  if (authState === null) return <div aria-busy="true">Loading…</div>;

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
      <Header />
      <Routes>
        <Route path="/setup" element={<SetupPage />} />
        <Route path="/" element={isAuthed ? <InboxPage /> : <Navigate to="/setup" replace />} />
        <Route
          path="/pr/:owner/:repo/:number"
          element={isAuthed ? <PrDetailPage /> : <Navigate to="/setup" replace />}
        >
          <Route index element={<OverviewTabPlaceholder />} />
          <Route path="files/*" element={<FilesTabPlaceholder />} />
          <Route path="drafts" element={<DraftsTabDisabled />} />
        </Route>
        <Route path="*" element={<Navigate to={isAuthed ? '/' : '/setup'} replace />} />
      </Routes>
      <ToastContainer />
    </>
  );

  return (
    <ErrorBoundary>
      <ToastProvider>
        {isAuthed ? <EventStreamProvider>{tree}</EventStreamProvider> : tree}
      </ToastProvider>
    </ErrorBoundary>
  );
}
