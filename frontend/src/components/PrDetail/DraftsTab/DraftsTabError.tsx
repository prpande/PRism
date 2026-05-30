import styles from './DraftsTabError.module.css';

interface DraftsTabErrorProps {
  onRetry: () => void;
}

export function DraftsTabError({ onRetry }: DraftsTabErrorProps) {
  return (
    <div className={`drafts-tab-error ${styles.draftsTabError}`} role="alert">
      <p>Couldn't load drafts.</p>
      <button type="button" className="btn btn-secondary" onClick={onRetry}>
        Retry
      </button>
    </div>
  );
}
