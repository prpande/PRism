import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { apiClient } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import type { ConnectResponse } from '../api/types';

export function SetupPage() {
  const { authState } = useAuth();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
      if (result.ok) {
        window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
        navigate('/');
      } else {
        setError(result.detail ?? result.error ?? 'Validation failed.');
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (authState === null) return <div aria-busy="true">Loading…</div>;

  return <SetupForm host={authState.host} onSubmit={onSubmit} error={error} busy={busy} />;
}
