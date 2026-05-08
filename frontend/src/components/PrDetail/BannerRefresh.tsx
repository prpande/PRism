interface BannerRefreshProps {
  hasUpdate: boolean;
  headShaChanged: boolean;
  commentCountDelta: number;
  currentIterationNumber: number;
  onReload: () => void;
  onDismiss: () => void;
}

export function BannerRefresh({
  hasUpdate,
  headShaChanged,
  commentCountDelta,
  currentIterationNumber,
  onReload,
  onDismiss,
}: BannerRefreshProps) {
  if (!hasUpdate) return null;

  const message = formatMessage(headShaChanged, commentCountDelta, currentIterationNumber);
  if (!message) return null;

  return (
    <div role="status" aria-live="polite" className="banner-refresh">
      <span className="banner-refresh-message">{message}</span>
      <div className="banner-refresh-actions">
        <button type="button" className="btn btn-primary btn-sm" onClick={onReload}>
          Reload
        </button>
        <button
          type="button"
          className="btn-icon banner-refresh-dismiss"
          onClick={onDismiss}
          aria-label="Dismiss banner"
        >
          <span aria-hidden="true">×</span>
        </button>
      </div>
    </div>
  );
}

function formatMessage(
  headShaChanged: boolean,
  commentCountDelta: number,
  currentIterationNumber: number,
): string {
  const parts: string[] = [];
  if (headShaChanged) parts.push(`Iteration ${currentIterationNumber + 1}`);
  if (commentCountDelta > 0) {
    const noun = commentCountDelta === 1 ? 'comment' : 'comments';
    parts.push(`${commentCountDelta} new ${noun}`);
  }

  if (parts.length === 0) return '';

  if (parts.length === 1 && headShaChanged) {
    return `${parts[0]} available — Reload to view`;
  }

  return `${parts.join(' + ')} — Reload to view`;
}
