import { Link, useLocation } from 'react-router-dom';
import styles from './WelcomePage.module.css';

// Placeholder copy (tagline + benefits) — the human rewrite is owned by #222.
// Keep it plain and honest, not faux-marketing. The leading emoji are decorative
// (aria-hidden); only the text is announced.
const BENEFITS: ReadonlyArray<{ emoji: string; text: string }> = [
  { emoji: '🔒', text: 'Local-first — your PAT never leaves this device.' },
  { emoji: '⚡', text: 'A focused PR-review workspace, not the GitHub web tab.' },
  { emoji: '🤖', text: 'AI hotspots surface the hunks worth a close look.' },
];

export function WelcomePage() {
  const location = useLocation();
  return (
    <div className={styles.screen}>
      <div className={styles.bg} aria-hidden="true" />
      <div className={styles.card} data-testid="welcome-card">
        {/* Decorative: the <h1> wordmark below already names the product, so a
            non-empty alt would make a screen reader announce "PRism" twice. */}
        <img src="/prism-logo.png" alt="" width={60} height={60} className={styles.logo} />
        {/* Keep the wordmark a BARE text node — welcome-page/app/e2e tests assert
            the h1's accessible name is exactly "PRism". A nested span or sibling
            text node would silently break the exact-name match across suites. */}
        <h1 className={styles.wordmark}>PRism</h1>
        <p className={styles.tagline}>Review pull requests without leaving your machine.</p>
        <ul className={styles.benefits}>
          {BENEFITS.map((b) => (
            <li key={b.text} className={styles.benefit}>
              <span className={styles.benefitEmoji} aria-hidden="true">
                {b.emoji}
              </span>
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
        <Link to="/setup" className={`${styles.cta} btn btn-primary btn-lg`}>
          Get started
        </Link>
        {/* Footer: Help is now a real link (#210). Send feedback remains a stub until #211. */}
        <div className={styles.footer}>
          <Link to="/help" state={{ backgroundLocation: location }} className={styles.footerLink}>
            Help
          </Link>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <span className={styles.footerStub}>Send feedback</span>
        </div>
      </div>
    </div>
  );
}
