import styles from './filters.module.css';

interface Props {
  value: string;
  onChange(value: string): void;
}

export function FilterSearchInput({ value, onChange }: Props) {
  return (
    <div className={styles.search}>
      {/* Monochrome accent line-icon (matches HelpIcon/welcomeIcons convention,
          replacing the multicolour 🔍 emoji). Colour comes from .searchIcon. */}
      <svg
        className={styles.searchIcon}
        width="14"
        height="14"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
        fill="none"
      >
        <circle cx="7" cy="7" r="4.5" stroke="currentColor" strokeWidth="1.2" />
        <line
          x1="10.6"
          y1="10.6"
          x2="14"
          y2="14"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeLinecap="round"
        />
      </svg>
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
