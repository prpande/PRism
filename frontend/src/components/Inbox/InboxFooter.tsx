import styles from './InboxFooter.module.css';

export function InboxFooter() {
  return (
    <div className={styles.footer}>
      Some PRs may be hidden — paste a PR URL above to access ones not in your inbox.
    </div>
  );
}
