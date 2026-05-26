import styles from './SettingsSections.module.css';

// Spec § 3.1 stub — full Replace-token UX lands in PR4. PR4 Task 4.x replaces
// this disabled button with an <a href="/setup?replace=1"> that drives the
// real flow; the literal "Replace token (lands in PR4)" string is a
// deliberate cross-PR pointer that PR4's grep-sweep step looks for.
//
// Native <button disabled> is removed from the keyboard tab order and AT
// announces it as "unavailable" — but `title` is not discoverable for the
// keyboard / SR path (focus skips the button, so the tooltip never appears).
// Render a visible helper span beneath the button and aria-describedby
// link it to the button so AT announces both the disabled state AND the
// explanation in the same focus-skip surface.
const STUB_HELP = 'Replace token UX lands in PR4 — the button is a placeholder for now.';

export function AuthSection() {
  return (
    <section aria-labelledby="auth-heading" className={styles.section}>
      <h2 id="auth-heading">Auth</h2>
      <div className={styles.row}>
        <button
          type="button"
          disabled
          aria-describedby="auth-replace-help"
          title={STUB_HELP}
          className={styles.stubLink}
        >
          Replace token (lands in PR4)
        </button>
      </div>
      <span id="auth-replace-help" className={styles.help}>
        {STUB_HELP}
      </span>
    </section>
  );
}
