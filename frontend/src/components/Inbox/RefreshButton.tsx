import { Spinner } from '../Spinner/Spinner';

interface Props {
  isRefreshing: boolean;
  justRefreshed: boolean;
  onRefresh: () => void;
}

// Manual inbox refresh. `btn btn-icon` (both classes — .btn supplies the inline-flex
// centering .btn-icon lacks, so the swapped-in spinner/checkmark stays centered).
// In-flight → decorative spinner; on success the circular-arrow briefly morphs to a
// checkmark (self-contained inside the button, so it can never overlap the Sort control);
// idle → circular-arrow. AT gets completion from the InboxPage role=status region, so the
// icon swaps are aria-hidden and the accessible name stays "Refresh inbox".
export function RefreshButton({ isRefreshing, justRefreshed, onRefresh }: Props) {
  return (
    <button
      type="button"
      className="btn btn-icon"
      aria-label={isRefreshing ? 'Refreshing inbox…' : 'Refresh inbox'}
      title="Refresh inbox"
      disabled={isRefreshing}
      onClick={onRefresh}
      data-testid="inbox-refresh-button"
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
          data-testid="inbox-refresh-confirm"
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
