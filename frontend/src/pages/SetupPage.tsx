import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { NoReposWarningModal } from '../components/Setup/NoReposWarningModal';
import { apiClient, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { replaceToken } from '../api/replaceToken';
import type { ConnectResponse } from '../api/types';

// Maps AuthReplaceError.error codes (PRism.Web/Endpoints/AuthEndpoints.cs) to
// user-facing copy. Centralized so the SetupPage render path stays slim.
function replaceErrorMessage(code: string | undefined, prRef: string | null | undefined): string {
  switch (code) {
    case 'submit-in-flight':
      return `A submit is in progress${prRef ? ` on ${prRef}` : ''}. Wait for it to finish, then try again.`;
    case 'pat-required':
      return 'Paste your new token before continuing.';
    case 'invalid-json':
      return 'Internal error while parsing the token. Please refresh and try again.';
    case 'no-token':
      return 'No existing token to replace. Connect first from the setup page.';
    case 'invalidtoken':
    case 'validation-failed':
      return 'GitHub rejected this token. Check the scopes and try again.';
    default:
      return code ? `Validation failed (${code}).` : 'Validation failed.';
  }
}

export function SetupPage() {
  const { authState } = useAuth();
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [showWarning, setShowWarning] = useState(false);
  // True if the user clicked "Edit token scope" while a commit was in flight.
  // The commit can't be cancelled server-side, but we MUST suppress the
  // post-commit navigate('/') so the user's "Edit" intent is honored.
  const editedDuringCommitRef = useRef(false);
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const isReplaceMode = searchParams.has('replace');
  const toast = useToast();

  const onConnect = async (pat: string) => {
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

  // Replace flow (spec § 3.2.1). Distinct from connect: the backend returns 4xx
  // on validation failure (apiClient.post throws ApiError) — no 200-with-ok=false
  // shape. On 200, we surface the identity-change toast only when the backend
  // flagged identityChanged=true; the message names the new login so the user
  // sees the swap was both attempted and committed.
  const onReplace = async (pat: string) => {
    setBusy(true);
    setError(undefined);
    try {
      const result = await replaceToken(pat);
      if (result.identityChanged) {
        const login = result.login ?? 'a new GitHub account';
        toast.show({
          kind: 'success',
          message: `Connected as ${login}. Drafts preserved; pending review IDs cleared so the new login can re-submit.`,
        });
      }
      navigate('/');
    } catch (e) {
      if (e instanceof ApiError) {
        const body = (e.body ?? null) as { error?: string; prRef?: string | null } | null;
        setError(replaceErrorMessage(body?.error, body?.prRef));
      } else {
        setError((e as Error).message);
      }
    } finally {
      setBusy(false);
    }
  };

  const onContinueAnyway = async () => {
    editedDuringCommitRef.current = false;
    setBusy(true);
    try {
      await apiClient.post<{ ok: boolean }>('/api/auth/connect/commit');
      if (editedDuringCommitRef.current) {
        // User clicked Edit mid-flight — respect that intent over the late navigate.
        return;
      }
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

  const onEdit = () => {
    editedDuringCommitRef.current = true;
    setShowWarning(false);
  };

  if (authState === null) return <div aria-busy="true">Loading…</div>;

  return (
    <>
      <SetupForm
        host={authState.host}
        onSubmit={isReplaceMode ? onReplace : onConnect}
        error={error}
        busy={busy}
        isReplaceMode={isReplaceMode}
      />
      {showWarning && (
        <NoReposWarningModal onContinue={onContinueAnyway} onEdit={onEdit} busy={busy} />
      )}
    </>
  );
}
