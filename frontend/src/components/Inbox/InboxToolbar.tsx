import { FilterBar, type FilterBarState } from './filters/FilterBar';
import type { InboxSection } from '../../api/types';
import type { SortKey } from './filters/applyInboxFilters';
import styles from './InboxToolbar.module.css';

interface Props {
  sections: InboxSection[];
  initialSort: SortKey;
  ciProbeComplete: boolean;
  onState(state: FilterBarState): void;
}

// One merged input (filter + paste-to-open) lives inside FilterBar now — the
// toolbar just wraps it (padding / background / bottom border).
export function InboxToolbar({ sections, initialSort, ciProbeComplete, onState }: Props) {
  return (
    <div className={styles.toolbar}>
      <FilterBar
        sections={sections}
        initialSort={initialSort}
        ciProbeComplete={ciProbeComplete}
        onState={onState}
      />
    </div>
  );
}
