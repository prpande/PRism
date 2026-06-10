import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../hooks/useAuth';
import { useStreamHealth } from '../../hooks/useStreamHealth';
import { Snackbar } from '../Snackbar';

const MESSAGE = 'Your GitHub access token is no longer valid';

/**
 * #312: non-dismissible re-auth banner. The VISIBLE bar shows whenever the stored
 * GitHub credential is invalid and we're authed, the SSE stream is healthy, and we're
 * not on /setup (which IS the fix). No dismiss — only a valid token clears it.
 *
 * a11y (spec §7.4): the polite live region is ALWAYS mounted (the component never
 * returns null) with its text keyed on the CREDENTIAL-INVALID edge (not the visible-bar
 * predicate), so a screen reader announces once when the credential goes bad and the
 * text does NOT flip on route/stream-health changes (e.g. navigating off /setup) —
 * avoiding repeated re-announce. The visible Snackbar carries NO role/aria-live so it
 * isn't a second, double-announcing region.
 */
export function GitHubAuthBanner() {
  const { authState } = useAuth();
  const { healthy } = useStreamHealth();
  const location = useLocation();
  const navigate = useNavigate();

  const invalid = authState?.hasToken === true && authState?.githubCredentialInvalid === true;
  const onSetup = location.pathname === '/setup';
  const show = invalid && healthy && !onSetup;

  return (
    <>
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {invalid ? MESSAGE : ''}
      </div>
      {show && (
        <Snackbar
          tone="danger"
          message={MESSAGE}
          action={{ label: 'Re-authorize', onClick: () => navigate('/setup?replace=1') }}
        />
      )}
    </>
  );
}
