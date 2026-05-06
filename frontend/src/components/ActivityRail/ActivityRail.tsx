import { activityItems, watchedRepos } from './activityData';
import styles from './ActivityRail.module.css';

export function ActivityRail() {
  return (
    <aside className={styles.rail} aria-label="Activity">
      <section className={styles.section}>
        <header className={styles.head}>
          <span className={styles.title}>Activity</span>
          <span className={styles.muted}>last 24h</span>
        </header>
        <ol className={styles.list}>
          {activityItems.map((it, i) => (
            <li key={i} className={styles.item}>
              <span className={styles.actor}>{it.who}</span> {it.what}{' '}
              <span className={styles.pr}>{it.pr}</span>
              <span className={styles.when}> · {it.when} ago</span>
            </li>
          ))}
        </ol>
      </section>
      <section className={styles.section}>
        <header className={styles.head}>
          <span className={styles.title}>Watching</span>
        </header>
        <ul className={styles.list}>
          {watchedRepos.map((r) => (
            <li key={r.repo} className={styles.item}>
              <span className={styles.repo}>{r.repo}</span>
              {r.count > 0 ? (
                <span className={styles.count}>{r.count}</span>
              ) : (
                <span className={styles.muted}>idle</span>
              )}
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}
