import { useRef, type KeyboardEvent } from 'react';
import styles from './SegmentedControl.module.css';

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

export interface SegmentedControlProps<T extends string> {
  label: string;
  options: readonly SegmentedOption<T>[];
  value: T;
  onChange: (value: T) => void;
  disabled?: boolean;
  variant?: 'segmented' | 'nav';
  /** id of an element describing the control; wired to the radiogroup's aria-describedby. */
  describedById?: string;
  /** When set, the selected radio carries data-modal-role={value} (lets a Modal host focus it on open). */
  selectedDataRole?: string;
}

export function SegmentedControl<T extends string>({
  label,
  options,
  value,
  onChange,
  disabled = false,
  variant = 'segmented',
  describedById,
  selectedDataRole,
}: SegmentedControlProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );

  const move = (e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    const next = (selectedIdx + delta + options.length) % options.length;
    onChange(options[next].value);
    refs.current[next]?.focus();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
  };

  const groupCls = variant === 'nav' ? styles.groupNav : styles.group;
  const segCls = variant === 'nav' ? styles.segNav : styles.seg;
  const segOnCls = variant === 'nav' ? styles.segNavOn : styles.segOn;

  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedById}
      className={groupCls}
      onKeyDown={onKeyDown}
    >
      {options.map((o, i) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={selected}
            // Roving tabindex follows selectedIdx (which falls back to 0 when
            // `value` isn't in options), NOT `selected`. If it keyed off
            // `selected`, an out-of-set value would leave every button at -1 and
            // the radiogroup unreachable by keyboard. Mirrors AccentSwatches.
            tabIndex={i === selectedIdx ? 0 : -1}
            disabled={disabled}
            className={`${segCls}${selected ? ` ${segOnCls}` : ''}`}
            onClick={() => onChange(o.value)}
            data-modal-role={selected ? selectedDataRole : undefined}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
