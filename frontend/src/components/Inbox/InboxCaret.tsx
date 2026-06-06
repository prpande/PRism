import styles from './InboxCaret.module.css';

/**
 * Disclosure caret shared by the inbox section headers and the repo-group
 * accordions. A right-pointing chevron that rotates 90° to point down when open
 * — the same treatment the file tree uses (#214), sized for discoverability
 * (the old `▸`/`▾` unicode glyphs were too small to read as an affordance).
 */
export function InboxCaret({ open }: { open: boolean }) {
  return (
    <span className={`${styles.caret}${open ? ` ${styles.open}` : ''}`} aria-hidden="true">
      <svg viewBox="0 0 16 16" width="16" height="16">
        <path
          d="M6 4l4 4-4 4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}
