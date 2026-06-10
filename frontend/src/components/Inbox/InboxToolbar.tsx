import { FilterBar, type FilterBarState } from './filters/FilterBar';
import type { InboxSection } from '../../api/types';
import type { SortKey } from './filters/applyInboxFilters';
import styles from './InboxToolbar.module.css';

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
  refresh: () => void;
  isRefreshing: boolean;
  justRefreshed: boolean;
}

// One merged input (filter + paste-to-open) lives inside FilterBar; the toolbar wraps it
// (padding / background / bottom border) and forwards the manual-refresh props (#311).
export function InboxToolbar({
  sections,
  initialSort,
  ciProbeComplete,
  onState,
  refresh,
  isRefreshing,
  justRefreshed,
}: Props) {
  return (
    <div className={styles.toolbar}>
      <FilterBar
        sections={sections}
        initialSort={initialSort}
        ciProbeComplete={ciProbeComplete}
        onState={onState}
        refresh={refresh}
        isRefreshing={isRefreshing}
        justRefreshed={justRefreshed}
      />
    </div>
  );
}
