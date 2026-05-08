import { useState } from 'react';
import type { IterationDto } from '../../../api/types';

export interface IterationTabStripProps {
  iterations: IterationDto[];
  activeRange: string;
  onRangeChange: (range: string) => void;
}

function iterRange(iter: IterationDto): string {
  return `${iter.beforeSha}..${iter.afterSha}`;
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

  return (
    <div className="iteration-tab-strip" role="tablist" aria-label="Iteration selector">
      <button
        className={`iteration-tab${activeRange === 'all' ? ' iteration-tab--active' : ''}`}
        role="tab"
        aria-selected={activeRange === 'all'}
        onClick={() => onRangeChange('all')}
      >
        All changes
      </button>

      {hasOverflow && (
        <div className="iteration-tab-overflow">
          <button
            className="iteration-tab iteration-tab--more"
            onClick={() => setDropdownOpen((o) => !o)}
            aria-expanded={dropdownOpen}
            aria-haspopup="listbox"
          >
            All iterations ▾
          </button>
          {dropdownOpen && (
            <div className="iteration-dropdown" role="listbox" aria-label="All iterations">
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
        return (
          <button
            key={iter.number}
            className={`iteration-tab${isActive ? ' iteration-tab--active' : ''}${disabled ? ' iteration-tab--disabled' : ''}`}
            role="tab"
            aria-selected={isActive}
            aria-disabled={disabled}
            onClick={() => {
              if (!disabled) onRangeChange(range);
            }}
          >
            {iter.hasResolvableRange
              ? `Iter ${iter.number}`
              : `Iter ${iter.number} (snapshot lost)`}
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
  return (
    <div
      className={`iteration-option${disabled ? ' iteration-option--disabled' : ''}`}
      role="option"
      aria-selected={isActive}
      aria-disabled={disabled}
      onClick={onSelect}
    >
      {iter.hasResolvableRange ? `Iter ${iter.number}` : `Iter ${iter.number} (snapshot lost)`}
    </div>
  );
}
