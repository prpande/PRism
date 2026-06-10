import { useCallback, useEffect, useRef, useState } from 'react';
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
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    // Defer focus so it lands after any click-sequence that triggered close
    // (outside-click: pointerdown fires before mouseup/click steal focus to body).
    setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  // Reset in-popover search query when closing so a stale-filtered list is
  // never shown on re-open.
  useEffect(() => {
    if (!open) setQ('');
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  const label = triggerLabel ?? (selected.length > 0 ? `${name} (${selected.length})` : name);
  const showSearch = values.length > 8;
  const shown = showSearch
    ? values.filter((v) => v.toLowerCase().includes(q.toLowerCase()))
    : values;

  return (
    <div
      className={styles.facet}
      ref={ref}
      onBlur={(e) => {
        // Close when keyboard focus (Tab / Shift-Tab) leaves the facet entirely.
        // relatedTarget inside ref = focus moved within the popover → keep open.
        // Unlike close(), don't refocus the trigger — the user is tabbing away.
        if (open && !ref.current?.contains(e.relatedTarget as Node)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.trigger} ${selected.length > 0 ? styles.triggerActive : ''}`}
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
              aria-label={`Filter ${name.toLowerCase()}`}
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
