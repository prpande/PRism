export interface WholeFileFailureBannerProps {
  reason: string;
  onDismiss: () => void;
  // #510: an in-place recovery so the banner is actionable, not just text + an X.
  // When provided, a Retry button re-attempts the whole-file fetch (re-enabling
  // whole-file view for this file). Omitted when no retry is meaningful.
  onRetry?: () => void;
}

export function WholeFileFailureBanner({
  reason,
  onDismiss,
  onRetry,
}: WholeFileFailureBannerProps) {
  return (
    <div className="banner banner-warning" role="alert" data-testid="whole-file-failure-banner">
      <span>Whole-file view unavailable: {reason}</span>
      {onRetry && (
        <button
          type="button"
          className="banner-action"
          aria-label="Retry whole-file view"
          onClick={onRetry}
        >
          Retry
        </button>
      )}
      <button
        type="button"
        className="banner-dismiss"
        aria-label="Dismiss whole-file error banner"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
