import { Link } from 'react-router-dom';
import { useSubmitInFlight } from '../../hooks/useSubmitInFlight';
import styles from './SettingsSections.module.css';

// Spec § 3.1 — Replace token affordance. Clicking navigates to /setup?replace=1,
// where SetupPage POSTs to /api/auth/replace (spec § 3.2.1). While a submit holds
// SubmitLockRegistry the link is aria-disabled with a tooltip naming the PR ref —
// the backend ALSO rejects a replace mid-submit with 409, so this guard is UX
// hardening, not security.
//
// Accessibility (Copilot iter-1):
//   - The link stays in the keyboard tab order (no tabIndex={-1}) so screen
//     readers reach it and announce aria-disabled + the aria-describedby span.
//   - CSS no longer applies pointer-events:none, so mouse hover surfaces the
//     title= tooltip. The click is neutralized by onClick={e => e.preventDefault()}
//     plus aria-disabled — react-router-dom's Link skips navigation when
//     defaultPrevented is true.
//   - Spec § 3.1 prescribed tabIndex={-1} + pointer-events:none AND a hover/focus
//     tooltip, which is internally inconsistent. Resolved in favor of the
//     hover/focus tooltip being actually reachable.
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
