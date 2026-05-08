import type { IterationDto } from '../../../api/types';

export interface ComparePickerProps {
  iterations: IterationDto[];
  fromIter: number | null;
  toIter: number | null;
  onCompare: (from: number, to: number) => void;
}

export function ComparePicker({ iterations, fromIter, toIter, onCompare }: ComparePickerProps) {
  const handleFromChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newFrom = Number(e.target.value);
    const currentTo = toIter ?? iterations[iterations.length - 1]?.number ?? 0;
    if (newFrom > currentTo) {
      onCompare(currentTo, newFrom);
    } else {
      onCompare(newFrom, currentTo);
    }
  };

  const handleToChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newTo = Number(e.target.value);
    const currentFrom = fromIter ?? iterations[0]?.number ?? 0;
    if (currentFrom > newTo) {
      onCompare(newTo, currentFrom);
    } else {
      onCompare(currentFrom, newTo);
    }
  };

  const isSameIter = fromIter !== null && toIter !== null && fromIter === toIter;

  return (
    <div className="compare-picker">
      <label className="compare-picker-label">
        <span className="compare-picker-label-text">Compare</span>
        <select
          aria-label="From iteration"
          value={fromIter ?? ''}
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
          value={toIter ?? ''}
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
          No changes between Iter {fromIter} and Iter {toIter}.
        </span>
      )}
    </div>
  );
}
