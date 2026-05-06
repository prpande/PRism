import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { NoReposWarningModal } from '../components/Setup/NoReposWarningModal';
import { apiClient, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import type { ConnectResponse } from '../api/types';

export function SetupPage() {
  const { authState } = useAuth();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
      if (!result.ok) {
        setError(result.detail ?? result.error ?? 'Validation failed.');
        return;
      }
      if (result.warning === 'no-repos-selected') {
        setShowWarning(true);
        return;
      }
      window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
      navigate('/');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onContinueAnyway = async () => {
    setBusy(true);
    try {
      await apiClient.post<{ ok: boolean }>('/api/auth/connect/commit');
      window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
      navigate('/');
    } catch (e) {
      // 409 means the in-memory transient is gone (process restart, double-commit).
      // The user needs to re-paste their token, not see a generic error.
      if (e instanceof ApiError && e.status === 409) {
        setError('Setup expired. Re-paste your token to try again.');
      } else {
        setError((e as Error).message);
      }
      setShowWarning(false);
    } finally {
      setBusy(false);
    }
  };

  const onEdit = () => setShowWarning(false);

  if (authState === null) return <div aria-busy="true">Loading…</div>;

  return (
    <>
      <SetupForm host={authState.host} onSubmit={onSubmit} error={error} busy={busy} />
      {showWarning && (
        <NoReposWarningModal onContinue={onContinueAnyway} onEdit={onEdit} busy={busy} />
      )}
    </>
  );
}
