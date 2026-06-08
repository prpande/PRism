import { PasteUrlInput } from './PasteUrlInput';
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

export function InboxToolbar({ sections, initialSort, ciProbeComplete, onState }: Props) {
  return (
    <div className={styles.toolbar}>
      <PasteUrlInput />
      <FilterBar
        sections={sections}
        initialSort={initialSort}
        ciProbeComplete={ciProbeComplete}
        onState={onState}
      />
    </div>
  );
}
