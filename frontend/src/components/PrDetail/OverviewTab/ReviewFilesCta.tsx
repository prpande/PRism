interface ReviewFilesCtaProps {
  hasFiles: boolean;
  onReviewFiles: () => void;
}

const EMPTY_HELP_ID = 'review-files-empty-help';

export function ReviewFilesCta({ hasFiles, onReviewFiles }: ReviewFilesCtaProps) {
  return (
    <div className="overview-cta">
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
        <p id={EMPTY_HELP_ID} className="overview-cta-empty muted">
          No files to review yet
        </p>
      )}
      <p className="overview-cta-footer muted">
        <kbd>j</kbd> next file · <kbd>k</kbd> previous · <kbd>v</kbd> mark viewed
      </p>
    </div>
  );
}
