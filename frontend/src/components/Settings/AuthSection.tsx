import styles from './SettingsSections.module.css';

// Spec § 3.1 stub — full Replace-token UX lands in PR4. PR4 Task 4.x replaces
// this disabled link with an <a href="/setup?replace=1"> that drives the
// real flow; the literal "Replace token (lands in PR4)" string is a
// deliberate cross-PR pointer that PR4's grep-sweep step looks for.
const STUB_TITLE = 'Replace token UX lands in PR4 — the disabled link is a placeholder.';

export function AuthSection() {
  return (
    <section aria-labelledby="auth-heading" className={styles.section}>
      <h2 id="auth-heading">Auth</h2>
      <div className={styles.row}>
        <span
          role="link"
          aria-disabled="true"
          tabIndex={0}
          title={STUB_TITLE}
          className={styles.stubLink}
        >
          Replace token (lands in PR4)
        </span>
        <span className={styles.srOnly}>{STUB_TITLE}</span>
      </div>
    </section>
  );
}
