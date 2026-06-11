import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/**
 * #312: one-way exit-gate for the replace screen. Once the user is on /setup while
 * the GitHub credential is invalid, they cannot leave until it becomes valid — any
 * away-navigation redirects back to /setup?replace=1. Mirrors the first-run gate but
 * scoped to the re-auth case (we do NOT tear down app state / isAuthed).
 */
export function ReauthRouteGuard({ credentialInvalid }: { credentialInvalid: boolean }) {
  const location = useLocation();
  const navigate = useNavigate();
  const enteredGate = useRef(false);
  const onSetup = location.pathname === '/setup';

  useEffect(() => {
    if (!credentialInvalid) {
      enteredGate.current = false;
      return;
    }
    if (onSetup) {
      enteredGate.current = true;
      return;
    }
    if (enteredGate.current) {
      navigate('/setup?replace=1', { replace: true });
    }
  }, [credentialInvalid, onSetup, navigate]);

  return null;
}
