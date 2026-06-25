import type { ChecksLeadGlyph } from './checksGlyphState';
import styles from './ChecksTabGlyph.module.css';

// Reuses the inbox CI vocabulary: amber "pending" dot, green "passing" tick.
// aria-hidden — the health summary rides the tab's aria-label (Task 11).
export function ChecksTabGlyph({ lead }: { lead: ChecksLeadGlyph }) {
  if (lead === 'in-progress') {
    return <span className={styles.dot} data-glyph="in-progress" aria-hidden="true" />;
  }
  if (lead === 'all-green') {
    return (
      <svg
        className={styles.tick}
        data-glyph="all-green"
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="13"
        height="13"
        fill="currentColor"
      >
        {/* Octicon check-16 — same path as InboxRow CI_GLYPH_PATH.passing */}
        <path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z" />
      </svg>
    );
  }
  return null;
}
