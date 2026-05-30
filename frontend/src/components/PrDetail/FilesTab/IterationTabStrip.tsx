import { useState } from 'react';
import type { IterationDto } from '../../../api/types';
import styles from './IterationTabStrip.module.css';

export interface IterationTabStripProps {
  iterations: IterationDto[];
  activeRange: string;
  onRangeChange: (range: string) => void;
}

function iterRange(iter: IterationDto): string {
  return `${iter.beforeSha}..${iter.afterSha}`;
}

function sumAdditions(iters: IterationDto[]): number {
  return iters.reduce((sum, iter) => sum + iter.commits.reduce((s, c) => s + c.additions, 0), 0);
}

function sumDeletions(iters: IterationDto[]): number {
  return iters.reduce((sum, iter) => sum + iter.commits.reduce((s, c) => s + c.deletions, 0), 0);
}

const INLINE_COUNT = 3;

export function IterationTabStrip({
  iterations,
  activeRange,
  onRangeChange,
}: IterationTabStripProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const inlineIters = iterations.slice(-INLINE_COUNT);
  const overflowIters = iterations.length > INLINE_COUNT ? iterations.slice(0, -INLINE_COUNT) : [];
  const hasOverflow = overflowIters.length > 0;

  // Literal-class-and-module pattern (D16): the bare BEM kebab classes
  // (`iteration-tab`, `iteration-tab--active`, ...) stay in JSX as the test
  // seam + future migration hook; the hashed module classes
  // (`styles.iterationTab`, ...) supply the paint. Vite's default
  // `localsConvention: 'camelCaseOnly'` only exposes camelCase identifiers
  // from the .module.css; the kebab original is dropped — that's why the CSS
  // rules are authored in camelCase from the start.
  //
  // iter-new-dot is intentionally omitted — IterationDto has no `isNew`
  // field, so there's no production data path. Deferred to PR9 per D28.

  const allActive = activeRange === 'all';
  const allChangesTotalAdd = sumAdditions(iterations);
  const allChangesTotalRem = sumDeletions(iterations);

  return (
    <div
      className={`iteration-tab-strip ${styles.iterationTabStrip}`}
      role="tablist"
      aria-label="Iteration selector"
      data-testid="iteration-tab-strip"
    >
      <button
        className={
          `iteration-tab${allActive ? ' iteration-tab--active' : ''} ` +
          `${styles.iterationTab}${allActive ? ` ${styles.iterationTabActive}` : ''}`
        }
        role="tab"
        aria-selected={allActive}
        onClick={() => onRangeChange('all')}
      >
        <span className={`iteration-chip-label ${styles.iterationChipLabel}`}>All changes</span>
        <span className={`iteration-chip-meta ${styles.iterationChipMeta}`}>
          <span className={`iteration-chip-add ${styles.iterationChipAdd}`}>
            +{allChangesTotalAdd}
          </span>
          <span className={`iteration-chip-rem ${styles.iterationChipRem}`}>
            -{allChangesTotalRem}
          </span>
        </span>
      </button>

      {hasOverflow && (
        <div className={`iteration-tab-overflow ${styles.iterationTabOverflow}`}>
          <button
            className={
              `iteration-tab iteration-tab--more ` +
              `${styles.iterationTab} ${styles.iterationTabMore}`
            }
            onClick={() => setDropdownOpen((o) => !o)}
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
            aria-label={`Show ${overflowIters.length} more iterations`}
          >
            <span className={`iteration-chip-num ${styles.iterationChipNum}`}>
              +{overflowIters.length}
            </span>
            <span className={`iteration-chip-label ${styles.iterationChipLabel}`}>
              All iterations ▾
            </span>
          </button>
          {dropdownOpen && (
            <div
              className={`iteration-dropdown ${styles.iterationDropdown}`}
              role="listbox"
              aria-label="All iterations"
            >
              {overflowIters.map((iter) => (
                <IterationOption
                  key={iter.number}
                  iter={iter}
                  isActive={activeRange === iterRange(iter)}
                  onSelect={() => {
                    if (!iter.hasResolvableRange) return;
                    onRangeChange(iterRange(iter));
                    setDropdownOpen(false);
                  }}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {inlineIters.map((iter) => {
        const range = iterRange(iter);
        const isActive = activeRange === range;
        const disabled = !iter.hasResolvableRange;
        const labelText = iter.hasResolvableRange
          ? `Iter ${iter.number}`
          : `Iter ${iter.number} (snapshot lost)`;
        const adds = iter.commits.reduce((sum, c) => sum + c.additions, 0);
        const rems = iter.commits.reduce((sum, c) => sum + c.deletions, 0);
        return (
          <button
            key={iter.number}
            className={
              `iteration-tab${isActive ? ' iteration-tab--active' : ''}` +
              `${disabled ? ' iteration-tab--disabled' : ''} ` +
              `${styles.iterationTab}` +
              `${isActive ? ` ${styles.iterationTabActive}` : ''}` +
              `${disabled ? ` ${styles.iterationTabDisabled}` : ''}`
            }
            role="tab"
            aria-selected={isActive}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) onRangeChange(range);
            }}
          >
            <span className={`iteration-chip-num ${styles.iterationChipNum}`}>{iter.number}</span>
            <span className={`iteration-chip-label ${styles.iterationChipLabel}`}>{labelText}</span>
            {!disabled && (
              <span className={`iteration-chip-meta ${styles.iterationChipMeta}`}>
                <span className={`iteration-chip-add ${styles.iterationChipAdd}`}>+{adds}</span>
                <span className={`iteration-chip-rem ${styles.iterationChipRem}`}>-{rems}</span>
              </span>
            )}
            {/* iter-new-dot omitted — no production data path; PR9 deferral per D28 */}
          </button>
        );
      })}
    </div>
  );
}

function IterationOption({
  iter,
  isActive,
  onSelect,
}: {
  iter: IterationDto;
  isActive: boolean;
  onSelect: () => void;
}) {
  const disabled = !iter.hasResolvableRange;
  const labelText = iter.hasResolvableRange
    ? `Iter ${iter.number}`
    : `Iter ${iter.number} (snapshot lost)`;
  return (
    <div
      className={
        `iteration-option${disabled ? ' iteration-option--disabled' : ''} ` +
        `${styles.iterationOption}${disabled ? ` ${styles.iterationOptionDisabled}` : ''}`
      }
      role="option"
      aria-selected={isActive}
      aria-disabled={disabled}
      onClick={onSelect}
    >
      <span className={`iteration-chip-num ${styles.iterationChipNum}`}>{iter.number}</span>
      <span className={`iteration-chip-label ${styles.iterationChipLabel}`}>{labelText}</span>
    </div>
  );
}
