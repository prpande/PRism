import type { FC } from 'react';
import { Link, useLocation } from 'react-router-dom';
import styles from './WelcomePage.module.css';
import { LockIcon, PanelsIcon } from './welcomeIcons';
import { PrismGlyph, DECORATIVE_PRISM_STROKE } from '../components/Ai/PrismGlyph';

// The shared PrismGlyph's default stroke scales to a sub-pixel hairline at the 18px
// benefit-row size, reading thinner and paler than the 1.5px LockIcon/PanelsIcon
// beside it. DECORATIVE_PRISM_STROKE lands the edges at the same visual weight (and
// enlarges the sparkle proportionally) without touching the AiMarker default.
function WelcomePrismIcon() {
  return <PrismGlyph strokeWidth={DECORATIVE_PRISM_STROKE} />;
}

// Welcome copy (#222) — the human rewrite of #212's placeholder. Plain and warm,
// not faux-marketing. The leading icons are monochrome and decorative (aria-hidden,
// defined in welcomeIcons.tsx); only the text is announced.
const BENEFITS: ReadonlyArray<{ Icon: FC; text: string }> = [
  {
    Icon: LockIcon,
    text: 'Local-first by design. Your token is stored encrypted on this machine, never on someone else’s server.',
  },
  {
    Icon: PanelsIcon,
    text: 'A workspace made for reviewing: the diff, the file tree, and your comments in one focused place.',
  },
  {
    Icon: WelcomePrismIcon,
    text: 'AI that surfaces the hunks worth a closer look, still in active development.',
  },
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
        <p className={styles.tagline}>
          A calmer place to review pull requests, right on your machine.
        </p>
        <ul className={styles.benefits}>
          {BENEFITS.map((b) => (
            <li key={b.text} className={styles.benefit}>
              <span className={styles.benefitIcon}>
                <b.Icon />
              </span>
              <span>{b.text}</span>
            </li>
          ))}
        </ul>
        <Link to="/setup" className={`${styles.cta} btn btn-primary btn-lg`}>
          Get started
        </Link>
        {/* Footer: Help is a real link (#210). Send feedback is a real link (#211). */}
        <div className={styles.footer}>
          <Link to="/help" state={{ backgroundLocation: location }} className={styles.footerLink}>
            Help
          </Link>
          <span className={styles.footerDivider} aria-hidden="true">
            ·
          </span>
          <Link
            to="/feedback"
            state={{ backgroundLocation: location }}
            className={styles.footerLink}
          >
            Send feedback
          </Link>
        </div>
      </div>
    </div>
  );
}
