import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { apiClient } from '../api/client';
import type { ConnectResponse } from '../api/types';

export function SetupPage() {
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const onSubmit = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await apiClient.post<ConnectResponse>('/api/auth/connect', { pat });
      if (result.ok) navigate('/inbox-shell');
      else setError(result.detail ?? result.error ?? 'Validation failed.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return <SetupForm host="https://github.com" onSubmit={onSubmit} error={error} busy={busy} />;
}
