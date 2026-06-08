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
  // Collapse entirely when no filter is active (no reserved height) so the toolbar
  // sits tight above the section list. Engaging a filter adds this one row — a minor,
  // expected shift — preferred over a permanent empty band (B1 visual call).
  if (!active) return null;
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
