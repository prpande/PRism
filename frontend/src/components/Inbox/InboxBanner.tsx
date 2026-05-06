import styles from './InboxBanner.module.css';

interface Props {
  summary: string;
  onReload: () => void;
  onDismiss: () => void;
}

export function InboxBanner({ summary, onReload, onDismiss }: Props) {
  return (
    <div className={styles.banner} role="status">
      <span className={styles.summary}>{summary} — </span>
      <button className={styles.reload} onClick={onReload}>
        Reload
      </button>
      <button className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}
