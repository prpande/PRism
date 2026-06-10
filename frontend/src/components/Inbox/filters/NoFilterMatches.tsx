import styles from './filters.module.css';

export function NoFilterMatches({ onClear }: { onClear(): void }) {
  return (
    <div className={styles.noMatch} role="status">
      No PRs match your filters ·{' '}
      <button type="button" className={styles.clear} onClick={onClear}>
        Clear
      </button>
    </div>
  );
}
