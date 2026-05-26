import { Link } from 'react-router-dom';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';
import styles from './SettingsSections.module.css';

// Spec § 3.1 — Replace token affordance. Clicking navigates to /setup?replace=1,
// where SetupPage POSTs to /api/auth/replace (spec § 3.2.1). While a submit holds
// SubmitLockRegistry the link is aria-disabled with a tooltip naming the PR ref —
// the backend ALSO rejects a replace mid-submit with 409, so this guard is UX
// hardening, not security. The tooltip is exposed two ways for keyboard/SR users:
// title= for pointer/focus tooltip (browser-native) and an aria-describedby span
// for AT — aria-disabled links can't focus, so screen readers reach the span via
// the descriptor relationship instead.
export function AuthSection() {
  const { inFlight, prRef } = useSubmitInFlight();

  if (inFlight) {
    const tooltipMsg = `Submit on ${prRef ?? 'a pull request'} in progress`;
    return (
      <section aria-labelledby="auth-heading" className={styles.section}>
        <h2 id="auth-heading">Auth</h2>
        <div className={styles.row}>
          <Link
            to="/setup?replace=1"
            aria-disabled="true"
            aria-describedby="auth-replace-help"
            tabIndex={-1}
            title={tooltipMsg}
            onClick={(e) => e.preventDefault()}
            className={styles.linkDisabled}
          >
            Replace token
          </Link>
        </div>
        <span id="auth-replace-help" className={styles.srOnly}>
          {tooltipMsg}
        </span>
      </section>
    );
  }

  return (
    <section aria-labelledby="auth-heading" className={styles.section}>
      <h2 id="auth-heading">Auth</h2>
      <div className={styles.row}>
        <Link to="/setup?replace=1">Replace token</Link>
      </div>
    </section>
  );
}
