interface ReviewFilesCtaProps {
  hasFiles: boolean;
  onReviewFiles: () => void;
}

export function ReviewFilesCta({ hasFiles, onReviewFiles }: ReviewFilesCtaProps) {
  return (
    <div className="overview-cta">
      <button
        type="button"
        className="btn btn-primary"
        onClick={onReviewFiles}
        disabled={!hasFiles}
        title={hasFiles ? undefined : 'No files to review yet'}
      >
        Review files
      </button>
      <p className="overview-cta-footer muted">
        <kbd>j</kbd> next file · <kbd>k</kbd> previous · <kbd>v</kbd> mark viewed
      </p>
    </div>
  );
}
