import { useEffect, useRef, useState } from 'react';
import styles from './filters.module.css';

interface Props {
  name: string;
  values: string[];
  selected: string[];
  onToggle(value: string): void;
  /** When set, overrides the trigger text (used by the CI facet's failing count). */
  triggerLabel?: string;
}

export function FilterFacet({ name, values, selected, onToggle, triggerLabel }: Props) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const label = triggerLabel ?? (selected.length > 0 ? `${name} (${selected.length})` : name);
  const showSearch = values.length > 8;
  const shown = showSearch
    ? values.filter((v) => v.toLowerCase().includes(q.toLowerCase()))
    : values;

  return (
    <div className={styles.facet} ref={ref}>
      <button
        type="button"
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {label} <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className={styles.popover} role="group" aria-label={`${name} filter`}>
          {showSearch && (
            <input
              className={styles.popoverSearch}
              placeholder={`Filter ${name.toLowerCase()}…`}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          )}
          {shown.map((v) => (
            <label key={v} className={styles.option}>
              <input type="checkbox" checked={selected.includes(v)} onChange={() => onToggle(v)} />
              <span>{v}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
