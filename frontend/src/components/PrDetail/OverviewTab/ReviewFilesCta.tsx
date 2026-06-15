import styles from './ReviewFilesCta.module.css';

interface ReviewFilesCtaProps {
  hasFiles: boolean;
  onReviewFiles: () => void;
}

const EMPTY_HELP_ID = 'review-files-empty-help';

export function ReviewFilesCta({ hasFiles, onReviewFiles }: ReviewFilesCtaProps) {
  return (
    <div className={styles.overviewCta}>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onReviewFiles}
        disabled={!hasFiles}
        aria-describedby={!hasFiles ? EMPTY_HELP_ID : undefined}
      >
        Review files
      </button>
      {!hasFiles && (
        <p id={EMPTY_HELP_ID} className={`${styles.overviewCtaEmpty} muted`}>
          No files to review yet
        </p>
      )}
      <p className={`${styles.overviewCtaFooter} muted`}>
        <kbd>j</kbd> next file · <kbd>k</kbd> previous · <kbd>v</kbd> mark viewed · <kbd>n</kbd>/
        <kbd>p</kbd> next/prev change
      </p>
    </div>
  );
}
