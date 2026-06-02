import styles from './InboxSection.module.css';

export function RecentlyClosedFooter() {
  return (
    <div className={styles.truncationHint}>
      Showing the 30 most recent — older closed PRs aren't listed. Paste a URL above to open one.
    </div>
  );
}
