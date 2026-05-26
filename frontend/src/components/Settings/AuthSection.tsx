import styles from './SettingsSections.module.css';

// Spec § 3.1 stub — full Replace-token UX lands in PR4. PR4 Task 4.x replaces
// this disabled button with an <a href="/setup?replace=1"> that drives the
// real flow; the literal "Replace token (lands in PR4)" string is a
// deliberate cross-PR pointer that PR4's grep-sweep step looks for.
//
// Native <button disabled> is the right primitive: it is removed from the
// keyboard tab order, screen readers announce it as "unavailable", and the
// title attribute supplies the explanation on hover/focus. A <span
// role="link" tabIndex={0}> alternative is a keyboard dead-end — users tab
// to it, press Enter, nothing happens, no feedback.
const STUB_TITLE = 'Replace token UX lands in PR4 — the disabled button is a placeholder.';

export function AuthSection() {
  return (
    <section aria-labelledby="auth-heading" className={styles.section}>
      <h2 id="auth-heading">Auth</h2>
      <div className={styles.row}>
        <button type="button" disabled title={STUB_TITLE} className={styles.stubLink}>
          Replace token (lands in PR4)
        </button>
      </div>
    </section>
  );
}
