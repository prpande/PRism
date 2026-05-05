import styles from './DiffBar.module.css';

interface Props {
  additions: number;
  deletions: number;
  max: number;
}

export function DiffBar({ additions, deletions, max }: Props) {
  const total = additions + deletions;
  if (!total) return null;
  const widthPct = Math.min(100, (total / max) * 100);
  const addPct = (additions / total) * 100;
  return (
    <span className={styles.diffbar} title={`+${additions} −${deletions}`}>
      <span className={styles.track}>
        <span className={styles.fill} style={{ width: `${widthPct}%` }}>
          <span className={styles.add} style={{ width: `${addPct}%` }} />
          <span className={styles.del} style={{ width: `${100 - addPct}%` }} />
        </span>
      </span>
    </span>
  );
}
