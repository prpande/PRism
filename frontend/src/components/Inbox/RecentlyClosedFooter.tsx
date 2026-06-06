import styles from './RecentlyClosedFooter.module.css';

export function RecentlyClosedFooter() {
  return (
    <div className={styles.caption}>
      Repositories with PRs you&apos;ve closed recently — most recent first.
    </div>
  );
}
