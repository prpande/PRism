import { Spinner } from '../Spinner/Spinner';
import styles from './RefreshButton.module.css';

interface Props {
  isRefreshing: boolean;
  justRefreshed: boolean;
  onRefresh: () => void;
}

// Manual inbox refresh. `btn btn-icon` (both classes — .btn supplies the inline-flex
// centering .btn-icon lacks, so the swapped-in spinner is centered). The visible
// confirmation is aria-hidden; AT gets completion from the InboxPage role=status region.
export function RefreshButton({ isRefreshing, justRefreshed, onRefresh }: Props) {
  return (
    <span className={styles.group}>
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
      {justRefreshed && (
        <span className={styles.confirm} aria-hidden="true" data-testid="inbox-refresh-confirm">
          Refreshed
        </span>
      )}
    </span>
  );
}
