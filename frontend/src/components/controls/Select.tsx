import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import styles from './Select.module.css';

export interface SelectOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
}

export interface SelectProps<T extends string | number> {
  options: SelectOption<T>[];
  value: T;
  onChange: (value: T) => void;
  id?: string;
  'aria-label'?: string;
  leadingIcon?: ReactNode;
  disabled?: boolean;
  className?: string;
}

const CARET = (
  <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" aria-hidden="true">
    <path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.94l3.72-3.72a.749.749 0 0 1 1.06 0Z" />
  </svg>
);

export function Select<T extends string | number>({
  options,
  value,
  onChange,
  id,
  'aria-label': ariaLabel,
  leadingIcon,
  disabled = false,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;

  // Empty options intentionally renders the trigger disabled/inert — a consumer passing an empty list gets a non-interactive control by design.
  const isDisabled = disabled || options.length === 0;
  const selectedIndex = options.findIndex((o) => o.value === value);
  const selectedLabel = selectedIndex >= 0 ? options[selectedIndex].label : '';

  const close = useCallback((refocus: boolean) => {
    setOpen(false);
    setActiveIndex(-1);
    // Defer focus so it lands after the click-sequence that closed us
    // (mirrors DiffSettingsMenu).
    if (refocus) setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const openList = useCallback(() => {
    if (isDisabled) return;
    const enabledSelected = selectedIndex >= 0 && !options[selectedIndex].disabled;
    setActiveIndex(enabledSelected ? selectedIndex : firstEnabled(options));
    setOpen(true);
  }, [isDisabled, options, selectedIndex]);

  const commit = useCallback(
    (index: number) => {
      const opt = options[index];
      if (!opt || opt.disabled) return;
      // Re-selecting the already-current value intentionally does not fire onChange — no spurious change events; locked by contract test.
      if (opt.value !== value) onChange(opt.value);
      close(true);
    },
    [options, value, onChange, close],
  );

  // Outside-click dismiss (net-new vs CommitMultiSelectPicker).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  const activeId = open && activeIndex >= 0 ? `${instanceId}-opt-${activeIndex}` : undefined;

  return (
    <div ref={rootRef} className={`${styles.root}${className ? ` ${className}` : ''}`}>
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel}
        disabled={isDisabled}
        className={styles.trigger}
        data-open={open || undefined}
        onClick={() => (open ? close(true) : openList())}
      >
        {leadingIcon && (
          <span className={styles.leading} aria-hidden="true">
            {leadingIcon}
          </span>
        )}
        <span className={styles.label}>{selectedLabel}</span>
        <span className={styles.caret}>{CARET}</span>
      </button>

      {open && (
        <div
          id={listboxId}
          role="listbox"
          aria-activedescendant={activeId}
          tabIndex={-1}
          className={styles.listbox}
        >
          {options.map((o, i) => (
            <div
              key={String(o.value)}
              id={`${instanceId}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled || undefined}
              className={[
                styles.option,
                i === activeIndex ? styles.optionActive : '',
                o.disabled ? styles.optionDisabled : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onPointerEnter={() => !o.disabled && setActiveIndex(i)}
              onClick={() => commit(i)}
            >
              <span className={styles.check} aria-hidden="true">
                {o.value === value ? '✓' : ''}
              </span>
              <span className={styles.optionLabel}>{o.label}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ===== Option-index helpers (module scope; shared with keyboard nav) =====

function firstEnabled<T extends string | number>(options: SelectOption<T>[]): number {
  return options.findIndex((o) => !o.disabled);
}
