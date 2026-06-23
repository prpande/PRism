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
      <Tile
        label="Viewed"
        value={`${viewedCount}/${filesCount}`}
        // The bare "N/M" ratio reads as "N slash M" to a screen reader; give it
        // a spoken-friendly label. (The plain integer tiles need no override.)
        valueAriaLabel={`Viewed: ${viewedCount} of ${filesCount} files`}
      />
    </dl>
  );
}

function Tile({
  label,
  value,
  valueAriaLabel,
}: {
  label: string;
  value: number | string;
  valueAriaLabel?: string;
}) {
  return (
    <div className={styles.statsTile} data-testid="stats-tile">
      <dt className={styles.statsTileLabel} data-testid="stats-tile-label">
        {label}
      </dt>
      <dd
        className={styles.statsTileValue}
        data-testid="stats-tile-value"
        aria-label={valueAriaLabel}
      >
        {value}
      </dd>
    </div>
  );
}
