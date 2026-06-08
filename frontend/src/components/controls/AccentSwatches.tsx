import { useRef, type KeyboardEvent } from 'react';
import type { Accent } from '../../api/types';
import styles from './AccentSwatches.module.css';

const ACCENTS: readonly { value: Accent; label: string }[] = [
  { value: 'indigo', label: 'Indigo' },
  { value: 'amber', label: 'Amber' },
  { value: 'teal', label: 'Teal' },
];

export interface AccentSwatchesProps {
  value: Accent;
  onChange: (value: Accent) => void;
  disabled?: boolean;
}

export function AccentSwatches({ value, onChange, disabled = false }: AccentSwatchesProps) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selectedIdx = Math.max(
    0,
    ACCENTS.findIndex((a) => a.value === value),
  );

  const move = (e: KeyboardEvent, delta: number) => {
    e.preventDefault();
    const next = (selectedIdx + delta + ACCENTS.length) % ACCENTS.length;
    onChange(ACCENTS[next].value);
    refs.current[next]?.focus();
  };

  return (
    <div
      role="radiogroup"
      aria-label="Accent"
      className={styles.group}
      onKeyDown={(e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') move(e, 1);
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') move(e, -1);
      }}
    >
      {ACCENTS.map((a, i) => {
        const selected = i === selectedIdx;
        return (
          <button
            key={a.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-label={a.label}
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            className={`${styles.swatch}${selected ? ` ${styles.swatchOn}` : ''}`}
            onClick={() => onChange(a.value)}
          >
            <span className={`${styles.dot} ${styles[a.value]}`} />
          </button>
        );
      })}
    </div>
  );
}
