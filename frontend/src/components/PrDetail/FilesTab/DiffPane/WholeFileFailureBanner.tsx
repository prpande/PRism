export interface WholeFileFailureBannerProps {
  reason: string;
  onDismiss: () => void;
}

export function WholeFileFailureBanner({ reason, onDismiss }: WholeFileFailureBannerProps) {
  return (
    <div className="banner banner-warning" role="alert" data-testid="whole-file-failure-banner">
      <span>Whole-file view unavailable: {reason}</span>
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
