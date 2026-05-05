import { Routes, Route, Navigate } from 'react-router-dom';
import { Header } from './components/Header/Header';
import { ErrorBoundary } from './components/ErrorBoundary';
import { ToastProvider, ToastContainer } from './components/Toast';
import { HostChangeModal } from './components/HostChangeModal/HostChangeModal';
import { SetupPage } from './pages/SetupPage';
import { InboxShellPage } from './pages/InboxShellPage';
import { useAuth } from './hooks/useAuth';
import { apiClient } from './api/client';

export function App() {
  const { authState, refetch } = useAuth();

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
          <Route path="/inbox-shell" element={<InboxShellPage />} />
          <Route
            path="*"
            element={<Navigate to={authState.hasToken ? '/inbox-shell' : '/setup'} replace />}
          />
        </Routes>
        <ToastContainer />
      </ToastProvider>
    </ErrorBoundary>
  );
}
