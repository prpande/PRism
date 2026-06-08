import styles from './filters.module.css';

interface Props {
  value: string;
  onChange(value: string): void;
}

export function FilterSearchInput({ value, onChange }: Props) {
  return (
    <div className={styles.search}>
      <span className={styles.searchIcon} aria-hidden="true">
        🔍
      </span>
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Filter PRs by title or repo…"
        aria-label="Filter PRs by title or repo"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onChange('');
        }}
      />
      {value && (
        <button
          type="button"
          className={styles.searchClear}
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          ✕
        </button>
      )}
    </div>
  );
}
