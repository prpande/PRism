import styles from './Spinner.module.css';

interface SpinnerProps {
  /** Ring diameter: 16 / 24 / 40px. Default 'md'. */
  size?: 'sm' | 'md' | 'lg';
  /** Accessible loading label (kept visually hidden). Default 'Loading…'. */
  label?: string;
  /** Layout hook for the call site (centering, margins). */
  className?: string;
}

/**
 * Reusable accent-colored loading spinner. Color resolves from the ring's own
 * `--spinner-color` (defaults to `--accent`), so it is immune to ambient text
 * color at the call site. `prefers-reduced-motion` swaps rotation for a gentle
 * opacity pulse. The visible label lives in the global `.sr-only` util so the
 * status region carries a non-empty accessible name.
 */
export function Spinner({ size = 'md', label = 'Loading…', className }: SpinnerProps) {
  const rootClass = [styles.root, className].filter(Boolean).join(' ');
  return (
    <span role="status" aria-live="polite" className={rootClass}>
      <span className={`${styles.ring} ${styles[size]}`} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
