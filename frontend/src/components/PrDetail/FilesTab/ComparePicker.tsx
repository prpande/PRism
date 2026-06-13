import type { IterationDto } from '../../../api/types';
import { Select } from '../../controls/Select';
import styles from './ComparePicker.module.css';

export interface ComparePickerProps {
  iterations: IterationDto[];
  fromIter: number | null;
  toIter: number | null;
  onCompare: (from: number, to: number) => void;
}

export function ComparePicker({ iterations, fromIter, toIter, onCompare }: ComparePickerProps) {
  const firstNum = iterations[0]?.number ?? 0;
  const lastNum = iterations[iterations.length - 1]?.number ?? 0;

  const effectiveFrom = fromIter ?? firstNum;
  const effectiveTo = toIter ?? lastNum;

  const handleFromChange = (newFrom: number) => {
    if (newFrom > effectiveTo) {
      onCompare(effectiveTo, newFrom);
    } else {
      onCompare(newFrom, effectiveTo);
    }
  };

  const handleToChange = (newTo: number) => {
    if (effectiveFrom > newTo) {
      onCompare(newTo, effectiveFrom);
    } else {
      onCompare(effectiveFrom, newTo);
    }
  };

  const isSameIter = effectiveFrom === effectiveTo;

  const iterOptions = iterations.map((iter) => ({
    value: iter.number,
    label: iter.hasResolvableRange ? `Iter ${iter.number}` : `Iter ${iter.number} (snapshot lost)`,
    disabled: !iter.hasResolvableRange,
  }));

  return (
    <div className={`compare-picker ${styles.comparePicker}`} data-testid="compare-picker">
      <label className={`compare-picker-label ${styles.comparePickerLabel}`}>
        <span className={`compare-picker-label-text ${styles.comparePickerLabelText}`}>
          Compare
        </span>
        <Select
          aria-label="From iteration"
          value={effectiveFrom}
          onChange={handleFromChange}
          options={iterOptions}
        />
      </label>

      <span className={`compare-picker-arrow ${styles.comparePickerArrow}`} aria-hidden="true">
        ⇄
      </span>

      <label className={`compare-picker-label ${styles.comparePickerLabel}`}>
        <Select
          aria-label="To iteration"
          value={effectiveTo}
          onChange={handleToChange}
          options={iterOptions}
        />
      </label>

      {isSameIter && (
        <span className={`compare-picker-empty muted ${styles.comparePickerEmpty}`} role="status">
          No changes between Iter {effectiveFrom} and Iter {effectiveTo}.
        </span>
      )}
    </div>
  );
}
