import { Skeleton } from '../Skeleton/Skeleton';
import type { EgressDisclosure } from '../../api/aiConsent';
import styles from './EgressDisclosureBody.module.css';

// Decorative inline glyph (aria-hidden) — no central icon set in this repo.
function WarningTriangleIcon({ className }: { className?: string }) {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      focusable="false"
      className={className}
    >
      <path
        d="M8 1.75 14.5 13.5H1.5L8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <path d="M8 6.25V9.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.85" fill="currentColor" />
    </svg>
  );
}

export function EgressDisclosureBody({ disclosure }: { disclosure: EgressDisclosure }) {
  return (
    <div className={styles.callout}>
      <div className={styles.calloutHead}>
        <WarningTriangleIcon className={styles.calloutIcon} />
        <span>
          Sent off your device to{' '}
          <strong className={styles.recipient}>{disclosure.recipient}</strong>:
        </span>
      </div>
      <ul className={styles.dataList}>
        {disclosure.dataCategories.map((c) => (
          <li key={c} className={styles.dataItem}>
            {c}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function EgressDisclosureSkeleton() {
  return (
    <div aria-busy="true">
      <span className="sr-only" aria-live="polite">
        Loading data-sharing disclosure…
      </span>
      <Skeleton height={14} />
      <Skeleton height={14} width="70%" />
      <div className={styles.skeletonCallout}>
        <Skeleton height={14} width="55%" />
        <Skeleton height={12} width="80%" />
        <Skeleton height={12} width="45%" />
      </div>
    </div>
  );
}
