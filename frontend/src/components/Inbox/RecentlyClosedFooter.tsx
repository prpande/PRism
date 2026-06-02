import styles from './InboxSection.module.css';

export function RecentlyClosedFooter({ count }: { count: number }) {
  return (
    <div className={styles.truncationHint}>
      Showing the {count} most recent — older closed PRs aren't listed. Paste a URL above to open
      one.
    </div>
  );
}
