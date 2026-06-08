import styles from './filters.module.css';

interface Props {
  active: boolean;
  filterCount: number;
  matchCount: number;
  totalCount: number;
  ciIncomplete: boolean;
  onClear(): void;
}

export function FilterSummary({
  active,
  filterCount,
  matchCount,
  totalCount,
  ciIncomplete,
  onClear,
}: Props) {
  if (!active) return <div className={styles.summary} aria-hidden="true" />; // reserve height
  return (
    <div className={styles.summary} role="status">
      {filterCount} {filterCount === 1 ? 'filter' : 'filters'} · showing {matchCount} of{' '}
      {totalCount} PRs
      {ciIncomplete && <span className={styles.ciHint}> · CI status may be incomplete</span>}{' '}
      <button
        type="button"
        className={styles.clear}
        aria-label="Clear all filters"
        onClick={onClear}
      >
        Clear
      </button>
    </div>
  );
}
