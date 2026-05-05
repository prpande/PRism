import styles from './EmptyAllSections.module.css';

export function EmptyAllSections() {
  return (
    <div className={styles.hint}>
      Nothing in your inbox right now. Try pasting a PR URL above to jump to a specific PR, or wait
      for a review request.
    </div>
  );
}
