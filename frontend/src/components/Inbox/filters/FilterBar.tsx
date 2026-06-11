import { useEffect } from 'react';
import type { CiStatus, InboxSection } from '../../../api/types';
import { useInboxFilters } from './useInboxFilters';
import type { FilterResult, SortKey } from './applyInboxFilters';
import { SORT_OPTIONS } from './applyInboxFilters';
import { InboxQueryInput } from './InboxQueryInput';
import { FilterFacet } from './FilterFacet';
import { FilterSummary } from './FilterSummary';
import { RefreshButton } from '../../controls/RefreshButton';
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
  // #311 — manual refresh, threaded from InboxPage via InboxToolbar.
  refresh: () => void;
  isRefreshing: boolean;
  justRefreshed: boolean;
}

export function FilterBar({
  sections,
  initialSort,
  ciProbeComplete,
  onState,
  refresh,
  isRefreshing,
  justRefreshed,
}: Props) {
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
        <InboxQueryInput value={f.query} onChange={f.setQuery} />
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
        {/* #311 — keep #300's restyled Sort control and the manual Refresh button
            grouped so they wrap together as one unit at narrow container widths. */}
        <div className={styles.sortRefreshGroup}>
          <span className={styles.sort}>
            <svg
              className={styles.sortGlyph}
              viewBox="0 0 16 16"
              width="13"
              height="13"
              fill="currentColor"
              aria-hidden="true"
            >
              {/* Neutral "sorted list" mark (decreasing bars) — NOT an asc/desc arrow;
                  the control has no direction toggle (#300). */}
              <path d="M0 4.25c0-.414.336-.75.75-.75h11.5a.75.75 0 0 1 0 1.5H.75A.75.75 0 0 1 0 4.25Zm2 4a.75.75 0 0 1 .75-.75h7.5a.75.75 0 0 1 0 1.5h-7.5A.75.75 0 0 1 2 8.25Zm2 4a.75.75 0 0 1 .75-.75h3.5a.75.75 0 0 1 0 1.5h-3.5a.75.75 0 0 1-.75-.75Z" />
            </svg>
            <select
              className={styles.sortSelect}
              aria-label="Sort"
              value={f.sort}
              onChange={(e) => f.setSort(e.target.value as SortKey)}
            >
              {SORT_OPTIONS.map((s) => (
                <option key={s.key} value={s.key}>
                  {s.label}
                </option>
              ))}
            </select>
            <svg
              className={styles.sortCaret}
              viewBox="0 0 16 16"
              width="11"
              height="11"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z" />
            </svg>
          </span>
          <RefreshButton
            isRefreshing={isRefreshing}
            justRefreshed={justRefreshed}
            onRefresh={refresh}
            label="Refresh inbox"
            refreshingLabel="Refreshing inbox…"
            title="Refresh inbox"
            testId="inbox-refresh-button"
            confirmTestId="inbox-refresh-confirm"
          />
        </div>
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
