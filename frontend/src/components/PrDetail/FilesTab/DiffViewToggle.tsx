// DiffViewToggle.tsx
import { useId } from 'react';
import type { DiffMode } from './DiffPane';
import { InlineDiffIcon, SideBySideDiffIcon } from './diffIcons';
import styles from './DiffViewToggle.module.css';

export interface DiffViewToggleProps {
  diffMode: DiffMode;
  onDiffModeChange: (mode: DiffMode) => void;
  splitDisabled?: boolean;
  splitDisabledReason?: string;
}

export function DiffViewToggle({
  diffMode,
  onDiffModeChange,
  splitDisabled = false,
  splitDisabledReason,
}: DiffViewToggleProps) {
  // Per-instance radio group name: under keep-alive, multiple PR-detail tabs
  // (hence multiple DiffViewToggle instances) are mounted at once. A static
  // name would group radios document-wide, so selecting in one tab would
  // visually deselect the same-name radio in another. useId keeps each toggle's
  // radios independent.
  const radioGroupName = useId();
  return (
    <div
      role="radiogroup"
      aria-label="Diff view"
      className={`diff-view-toggle ${styles.diffViewToggle}`}
      data-testid="diff-view-toggle"
    >
      <label className={`${styles.tile}${diffMode === 'unified' ? ` ${styles.tileSelected}` : ''}`}>
        <input
          type="radio"
          name={radioGroupName}
          className={styles.srInput}
          checked={diffMode === 'unified'}
          onChange={() => onDiffModeChange('unified')}
          data-testid="diff-view-unified"
        />
        <InlineDiffIcon />
        <span className={styles.tileLabel}>Unified</span>
      </label>
      <label
        className={`${styles.tile}${diffMode === 'side-by-side' ? ` ${styles.tileSelected}` : ''}${splitDisabled ? ` ${styles.tileDisabled}` : ''}`}
        title={splitDisabled ? splitDisabledReason : undefined}
      >
        <input
          type="radio"
          name={radioGroupName}
          className={styles.srInput}
          checked={diffMode === 'side-by-side'}
          disabled={splitDisabled}
          onChange={() => onDiffModeChange('side-by-side')}
          data-testid="diff-view-split"
        />
        <SideBySideDiffIcon />
        <span className={styles.tileLabel}>Split</span>
      </label>
    </div>
  );
}
