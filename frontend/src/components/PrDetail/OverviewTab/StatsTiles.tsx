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
    <dl className="stats-tiles">
      <Tile label="Files" value={filesCount} />
      <Tile label="Drafts" value={draftsCount} />
      <Tile label="Threads" value={threadsCount} />
      <Tile label="Viewed" value={`${viewedCount}/${filesCount}`} />
    </dl>
  );
}

function Tile({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="stats-tile">
      <dt className="stats-tile-label">{label}</dt>
      <dd className="stats-tile-value">{value}</dd>
    </div>
  );
}
