import styles from './Logo.module.css';

interface LogoProps {
  // When true, render the visible "PRism" wordmark beside the mark and make the
  // mark decorative (alt=""), so assistive tech announces the name once. When
  // false (default), no visible label exists, so the mark carries the name
  // (alt="PRism"). Encapsulating both here keeps the visible-text ⇄ alt pair from
  // ever drifting apart. Header decides the boolean (#215).
  showName?: boolean;
}

export function Logo({ showName = false }: LogoProps) {
  return (
    <span className={styles.lockup}>
      <img
        src="/prism-logo.png"
        alt={showName ? '' : 'PRism'}
        width={28}
        height={28}
        className={styles.logo}
      />
      {showName && <span className={styles.wordmark}>PRism</span>}
    </span>
  );
}
