import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import styles from './NumberStepper.module.css';

export interface NumberStepperProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (value: number) => void;
  // When provided, the spinbutton is named via aria-labelledby pointing at this EXTERNAL label id (used
  // inside a Settings row that renders its own pane.label, so the row stays visually consistent with the
  // others). When omitted, the control renders its OWN visible label (standalone usage / unit tests).
  labelledById?: string;
}

// Accessible numeric stepper (spec §). The CONTAINER is the spinbutton (focusable, owns all keyboard
// events); the −/+ buttons are pointer affordances only (aria-hidden, tabIndex -1, no aria-label — the
// spinbutton is the single AT-exposed control, APG pattern). Apply-on-success: onChange is wired to
// usePreferences().set by the consumer, which echoes the server-clamped value back through `value`.
export function NumberStepper({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  labelledById,
}: NumberStepperProps) {
  const internalLabelId = useId();

  // Optimistic display: seed from `value`, advance INSTANTLY on each step so rapid presses COMPOUND
  // (rather than recomputing from a `value` prop that is stale until the apply-on-success POST echoes),
  // and reconcile whenever the server-echoed `value` changes. Without this, two quick presses both read
  // the pre-POST value and the second press is lost.
  const [display, setDisplay] = useState(value);
  useEffect(() => setDisplay(value), [value]);

  const pageStep = step * 10; // large step for PageUp/PageDown (snap() re-clamps to range)

  // Snap to the step grid (relative to min) and clamp to [min,max]. The control can therefore never
  // emit an out-of-range value, so the server clamp is an unreachable backstop from this path.
  const snap = (n: number) => {
    const clamped = Math.min(max, Math.max(min, n));
    const snapped = min + Math.round((clamped - min) / step) * step;
    return Math.min(max, Math.max(min, snapped));
  };
  const commit = (next: number) => {
    const v = snap(next);
    if (v !== display) {
      setDisplay(v);
      onChange(v);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    let next: number;
    switch (e.key) {
      case 'ArrowUp':
        next = display + step;
        break;
      case 'ArrowDown':
        next = display - step;
        break;
      case 'PageUp':
        next = display + pageStep;
        break;
      case 'PageDown':
        next = display - pageStep;
        break;
      case 'Home':
        next = min;
        break;
      case 'End':
        next = max;
        break;
      default:
        return;
    }
    e.preventDefault();
    commit(next);
  };

  const atMin = display <= min;
  const atMax = display >= max;

  return (
    <div className={styles.wrap}>
      {labelledById ? null : (
        <span id={internalLabelId} className={styles.label}>
          {label}
        </span>
      )}
      <div
        role="spinbutton"
        tabIndex={0}
        aria-labelledby={labelledById ?? internalLabelId}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={display}
        aria-valuetext={`${display} ${unit}`}
        className={styles.stepper}
        onKeyDown={onKeyDown}
      >
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className={styles.btn}
          disabled={atMin}
          onClick={() => commit(display - step)}
        >
          −
        </button>
        <span className={styles.value}>
          {display}
          <span className={styles.unit}> {unit}</span>
        </span>
        <button
          type="button"
          aria-hidden="true"
          tabIndex={-1}
          className={styles.btn}
          disabled={atMax}
          onClick={() => commit(display + step)}
        >
          +
        </button>
      </div>
    </div>
  );
}
