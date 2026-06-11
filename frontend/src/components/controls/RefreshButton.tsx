import { Spinner } from '../Spinner/Spinner';

interface Props {
  isRefreshing: boolean;
  justRefreshed: boolean;
  onRefresh: () => void;
  /** Idle / completion accessible name (e.g. "Refresh inbox" / "Refresh PR"). */
  label: string;
  /** In-flight accessible name (e.g. "Refreshing inbox…"). */
  refreshingLabel: string;
  /** Native tooltip text. */
  title: string;
  testId: string;
  confirmTestId: string;
}

// Shared manual-refresh icon button (#341 inbox, #344 pr-detail). `btn btn-icon` (both classes —
// .btn supplies the inline-flex centering .btn-icon lacks). In-flight → decorative spinner; on
// success the circular-arrow briefly morphs to a checkmark; idle → circular-arrow. AT gets
// completion from the host's role=status region, so the icon swaps are aria-hidden and the
// accessible name stays `label`.
export function RefreshButton({
  isRefreshing,
  justRefreshed,
  onRefresh,
  label,
  refreshingLabel,
  title,
  testId,
  confirmTestId,
}: Props) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={isRefreshing ? refreshingLabel : label}
      title={title}
      disabled={isRefreshing}
      onClick={onRefresh}
      data-testid={testId}
    >
      {isRefreshing ? (
        <Spinner decorative size="sm" />
      ) : justRefreshed ? (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
          data-testid={confirmTestId}
        >
          <path d="M20 6 9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d="M21 12a9 9 0 1 1-2.64-6.36" />
          <path d="M21 3v6h-6" />
        </svg>
      )}
    </button>
  );
}
