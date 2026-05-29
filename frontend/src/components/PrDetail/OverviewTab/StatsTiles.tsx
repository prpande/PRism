import styles from './StatsTiles.module.css';

interface StatsTilesProps {
  filesCount: number;
  draftsCount: number;
  threadsCount: number;
  viewedCount: number;
}

export function StatsTiles({
  filesCount,
  draftsCount,
  threadsCount,
  viewedCount,
}: StatsTilesProps) {
  return (
    <dl className={styles.statsTiles}>
      <Tile label="Files" value={filesCount} />
      <Tile label="Drafts" value={draftsCount} />
      <Tile label="Threads" value={threadsCount} />
      <Tile label="Viewed" value={`${viewedCount}/${filesCount}`} />
    </dl>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className={styles.statsTile} data-testid="stats-tile">
      <dt className={styles.statsTileLabel}>{label}</dt>
      <dd className={styles.statsTileValue}>{value}</dd>
    </div>
  );
}
