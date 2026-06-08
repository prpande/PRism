import { useEffect } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import { useInboxFilters } from './useInboxFilters';
import type { FilterResult, SortKey } from './applyInboxFilters';
import { SORT_OPTIONS } from './applyInboxFilters';
import { FilterSearchInput } from './FilterSearchInput';
import { FilterFacet } from './FilterFacet';
import { FilterSummary } from './FilterSummary';
import styles from './filters.module.css';

const CI_VALUES: CiStatus[] = ['failing', 'pending'];

// FilterBar owns the hook and reports BOTH the filtered result and the `clear`
// handler up, so InboxPage's zero-match state shares the exact same `clear` as
// the in-bar summary — no need to lift the hook into the page.
export interface FilterBarState {
  result: FilterResult;
  clear: () => void;
}

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
}

export function FilterBar({ sections, initialSort, ciProbeComplete, onState }: Props) {
  const f = useInboxFilters(sections, initialSort);
  // `onState` MUST be a stable reference (a useState setter like InboxPage's
  // `setFilterState`, or a useCallback) — an inline arrow would re-fire this effect
  // every render. f.clear is a []-dep useCallback; f.result only changes with the data.
  useEffect(() => onState({ result: f.result, clear: f.clear }), [f.result, f.clear, onState]);

  const failingCount = sections.reduce(
    (n, s) => n + s.items.filter((p) => p.ci === 'failing').length,
    0,
  );
  const ciTrigger =
    f.filters.ci.length > 0 ? `CI (${f.filters.ci.length})` : `CI · ${failingCount}`;
  const filterCount =
    (f.filters.text.trim() ? 1 : 0) +
    f.filters.ci.length +
    f.filters.repos.length +
    f.filters.authors.length;

  return (
    <div className={styles.bar}>
      <div className={styles.barRow}>
        <FilterSearchInput value={f.filters.text} onChange={f.setText} />
      </div>
      <div className={styles.barRow}>
        <FilterFacet
          name="CI"
          values={CI_VALUES}
          selected={f.filters.ci}
          onToggle={(v) => f.toggleCi(v as CiStatus)}
          triggerLabel={ciTrigger}
        />
        <FilterFacet
          name="Repo"
          values={f.repoValues}
          selected={f.filters.repos}
          onToggle={f.toggleRepo}
        />
        <FilterFacet
          name="Author"
          values={f.authorValues}
          selected={f.filters.authors}
          onToggle={f.toggleAuthor}
        />
        <span className={styles.spring} />
        <label className={styles.sort}>
          Sort:{' '}
          <select value={f.sort} onChange={(e) => f.setSort(e.target.value as SortKey)}>
            {SORT_OPTIONS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <FilterSummary
        active={f.active}
        filterCount={filterCount}
        matchCount={f.result.matchCount}
        totalCount={f.result.totalCount}
        ciIncomplete={!ciProbeComplete}
        onClear={f.clear}
      />
    </div>
  );
}
