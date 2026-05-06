import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { SetupPage } from './pages/SetupPage';
import { InboxPage } from './pages/InboxPage';
import { S3StubPrPage } from './pages/S3StubPrPage';
import { useAuth } from './hooks/useAuth';
import { apiClient } from './api/client';

export function App() {
  const { authState, error, refetch } = useAuth();

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

  return (
    <ErrorBoundary>
      <ToastProvider>
        <Header />
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route
            path="/"
            element={authState.hasToken ? <InboxPage /> : <Navigate to="/setup" replace />}
          />
          <Route
            path="/pr/:owner/:repo/:number"
            element={authState.hasToken ? <S3StubPrPage /> : <Navigate to="/setup" replace />}
          />
          <Route path="*" element={<Navigate to={authState.hasToken ? '/' : '/setup'} replace />} />
        </Routes>
        <ToastContainer />
      </ToastProvider>
    </ErrorBoundary>
  );
}
