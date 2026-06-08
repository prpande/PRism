import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { SetupForm } from '../components/Setup/SetupForm';
import { NoReposWarningModal } from '../components/Setup/NoReposWarningModal';
import { LoadingScreen } from '../components/LoadingScreen';
import styles from './SetupPage.module.css';
import { apiClient, ApiError } from '../api/client';
import { useAuth } from '../hooks/useAuth';
import { useToast } from '../components/Toast';
import { replaceToken } from '../api/replaceToken';
import { connectErrorMessage, replaceErrorMessage } from '../components/Setup/tokenErrorCopy';
import type { ConnectResponse } from '../api/types';

// Shown when the token was accepted but the follow-up /api/auth/state refetch
// could not confirm the session (transient network/server error). We stay on
// /setup and let the user retry rather than navigate into a routing-gate bounce.
const SESSION_UNCONFIRMED =
  "Connected, but we couldn't confirm your session. Check your connection, then try again.";

export function SetupPage() {
  const { authState, refetch } = useAuth();
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
        setError(connectErrorMessage(result.error));
        return;
      }
      if (result.warning === 'no-repos-selected') {
        setShowWarning(true);
        return;
      }
      window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
      // Refresh the SHARED auth state so App's route gate (isAuthed) observes
      // hasToken=true BEFORE we navigate, and ONLY navigate once that's
      // confirmed. refetch() swallows its error (returns null), so navigating
      // unconditionally would let a failed /api/auth/state fetch fall through to
      // navigate('/') with a stale hasToken=false — the gate then bounces to
      // unauthedTarget (/welcome on first run), the very loop this fix removes.
      const confirmed = await refetch();
      if (confirmed?.hasToken) {
        navigate('/');
      } else {
        setError(SESSION_UNCONFIRMED);
      }
    } catch (e) {
      if (e instanceof ApiError) {
        const body = e.body;
        const code =
          typeof body === 'object' && body !== null
            ? (body as { error?: unknown }).error
            : undefined;
        setError(connectErrorMessage(typeof code === 'string' ? code : undefined));
      } else {
        setError(connectErrorMessage('networkerror'));
      }
    } finally {
      setBusy(false);
    }
  };

  // Replace flow (spec § 3.2.1). Distinct from connect: the backend returns 4xx
  // on validation failure (apiClient.post throws ApiError) — no 200-with-ok=false
  // shape. On 200, we surface the identity-change toast only when the backend
  // flagged identityChanged=true; the message names the new login so the user
  // sees the swap was both attempted and committed. prism-auth-recovered fires
  // before the navigate so App.tsx's `isAuthed = hasToken && !authInvalidated`
  // gate doesn't bounce a previously-401'd-session user back to /setup after
  // a successful Replace.
  //
  // Error channel: spec § 3.1.1 (design.md:254) routes Replace-flow errors
  // (validation failure, 409 submit-in-flight) through the toast surface, not
  // the inline pill. Stays on /setup?replace=1 so the user can retry.
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
      window.dispatchEvent(new CustomEvent('prism-auth-recovered'));
      // Gate the navigate on a confirmed refetch — see onConnect for why.
      const confirmed = await refetch();
      if (confirmed?.hasToken) {
        navigate('/');
      } else {
        toast.show({ kind: 'error', message: SESSION_UNCONFIRMED });
      }
    } catch (e) {
      let message: string;
      if (e instanceof ApiError) {
        // apiClient.request falls back to the raw response text when the body
        // doesn't parse as JSON (corporate proxy HTML 502, AV interceptor, etc.),
        // so e.body can be a string at runtime. Type-guard before reading .error
        // so an HTML error page doesn't silently funnel into the generic
        // "Validation failed." default with no infrastructure-vs-validation
        // distinction visible to the user.
        const body = e.body;
        const code =
          typeof body === 'object' && body !== null
            ? (body as { error?: unknown }).error
            : undefined;
        message = replaceErrorMessage(typeof code === 'string' ? code : undefined);
      } else {
        message = (e as Error).message;
      }
      toast.show({ kind: 'error', message });
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
      // Gate the navigate on a confirmed refetch — see onConnect for why.
      const confirmed = await refetch();
      if (confirmed?.hasToken) {
        navigate('/');
      } else {
        setError(SESSION_UNCONFIRMED);
        setShowWarning(false);
      }
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

  if (authState === null) return <LoadingScreen />;

  return (
    <>
      <div className={styles.screen}>
        <div className={styles.bg} aria-hidden="true" />
        <div className={styles.card} data-testid="setup-card">
          <SetupForm
            host={authState.host}
            onSubmit={isReplaceMode ? onReplace : onConnect}
            error={error}
            onErrorClear={() => setError(undefined)}
            busy={busy}
            isReplaceMode={isReplaceMode}
            showBackToWelcome={!authState.hasToken}
          />
        </div>
      </div>
      {showWarning && (
        <NoReposWarningModal onContinue={onContinueAnyway} onEdit={onEdit} busy={busy} />
      )}
    </>
  );
}
