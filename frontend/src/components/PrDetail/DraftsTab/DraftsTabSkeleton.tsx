import styles from './DraftsTabSkeleton.module.css';

export function DraftsTabSkeleton() {
  return (
    <div
      className={`drafts-tab-skeleton ${styles.draftsTabSkeleton}`}
      data-testid="drafts-tab-skeleton"
      aria-busy="true"
    >
      <div
        className={`drafts-tab-skeleton-header skeleton-row ${styles.draftsTabSkeletonHeader}`}
      />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
      <div className="skeleton-row" />
    </div>
  );
}
