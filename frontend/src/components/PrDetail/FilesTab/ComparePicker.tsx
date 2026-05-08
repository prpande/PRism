import type { IterationDto } from '../../../api/types';

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

  const handleFromChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFrom = Number(e.target.value);
    if (newFrom > effectiveTo) {
      onCompare(effectiveTo, newFrom);
    } else {
      onCompare(newFrom, effectiveTo);
    }
  };

  const handleToChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newTo = Number(e.target.value);
    if (effectiveFrom > newTo) {
      onCompare(newTo, effectiveFrom);
    } else {
      onCompare(effectiveFrom, newTo);
    }
  };

  const isSameIter = effectiveFrom === effectiveTo;

  return (
    <div className="compare-picker">
      <label className="compare-picker-label">
        <span className="compare-picker-label-text">Compare</span>
        <select
          aria-label="From iteration"
          value={effectiveFrom}
          onChange={handleFromChange}
          className="compare-picker-select"
        >
          {iterations.map((iter) => (
            <option key={iter.number} value={iter.number} disabled={!iter.hasResolvableRange}>
              {iter.hasResolvableRange
                ? `Iter ${iter.number}`
                : `Iter ${iter.number} (snapshot lost)`}
            </option>
          ))}
        </select>
      </label>

      <span className="compare-picker-arrow">⇄</span>

      <label className="compare-picker-label">
        <select
          aria-label="To iteration"
          value={effectiveTo}
          onChange={handleToChange}
          className="compare-picker-select"
        >
          {iterations.map((iter) => (
            <option key={iter.number} value={iter.number} disabled={!iter.hasResolvableRange}>
              {iter.hasResolvableRange
                ? `Iter ${iter.number}`
                : `Iter ${iter.number} (snapshot lost)`}
            </option>
          ))}
        </select>
      </label>

      {isSameIter && (
        <span className="compare-picker-empty" role="status">
          No changes between Iter {effectiveFrom} and Iter {effectiveTo}.
        </span>
      )}
    </div>
  );
}
