import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useDismissableMenu } from '../../hooks/useDismissableMenu';
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
  const typeahead = useRef({ buffer: '', timer: 0 });
  const instanceId = useId();
  const listboxId = `${instanceId}-listbox`;

  // Empty OR all-disabled options render the trigger disabled/inert — a consumer
  // with nothing selectable gets a non-interactive control by design (avoids an
  // "open but unresponsive" list where Enter/Space silently no-op).
  const isDisabled = disabled || options.length === 0 || options.every((o) => o.disabled);

  // Dev-only authoring guard, in an effect so it fires when the labeling props
  // change — not on every re-render (e.g. each keystroke) or StrictMode double-invoke.
  useEffect(() => {
    if (import.meta.env.DEV && !id && !ariaLabel) {
      console.warn(
        'Select: provide either `id` (with a <label htmlFor>) or `aria-label` for an accessible name.',
      );
    }
  }, [id, ariaLabel]);

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

  const onKeyDown = (e: KeyboardEvent) => {
    if (isDisabled) return;
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openList();
      }
      return;
    }
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setActiveIndex((cur) => nextEnabled(options, cur, 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setActiveIndex((cur) => nextEnabled(options, cur, -1));
        break;
      case 'Home':
        e.preventDefault();
        setActiveIndex(firstEnabled(options));
        break;
      case 'End':
        e.preventDefault();
        setActiveIndex(lastEnabled(options));
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        commit(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        close(true);
        break;
      case 'Tab':
        // Close, but let focus move on naturally — no preventDefault, no refocus,
        // so a keyboard user can Tab past an open Select in the Settings form.
        close(false);
        break;
      default:
        if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          const ta = typeahead.current;
          window.clearTimeout(ta.timer);
          ta.timer = window.setTimeout(() => (ta.buffer = ''), 500);
          ta.buffer += e.key.toLowerCase();
          const match = matchTypeahead(options, ta.buffer, activeIndex);
          if (match >= 0) setActiveIndex(match);
        }
    }
  };

  // Clear any pending type-ahead buffer-reset timer on unmount.
  useEffect(() => () => window.clearTimeout(typeahead.current.timer), []);

  // Outside-pointerdown dismiss via the shared hook (#705). The hook's document
  // Escape is inert here: the combobox root's onKeyDown handles Escape first
  // and stopPropagations it (so an open Select inside a dialog closes without
  // closing the dialog) — the event never reaches the hook's document listener.
  useDismissableMenu({
    open,
    rootRef,
    returnFocusRef: triggerRef,
    onClose: () => close(false),
  });

  const activeId = open && activeIndex >= 0 ? `${instanceId}-opt-${activeIndex}` : undefined;

  return (
    <div
      ref={rootRef}
      className={`${styles.root}${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        id={id}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listboxId : undefined}
        // aria-activedescendant lives on the focused element (this trigger keeps
        // DOM focus; the listbox is never focused) so AT announces the active
        // option during keyboard nav. WAI-ARIA combobox pattern.
        aria-activedescendant={activeId}
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
        <div id={listboxId} role="listbox" tabIndex={-1} className={styles.listbox}>
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

function lastEnabled<T extends string | number>(options: SelectOption<T>[]): number {
  for (let i = options.length - 1; i >= 0; i--) if (!options[i].disabled) return i;
  return -1;
}

// Move `delta` from `current`, skipping disabled options. Clamp at the first/last
// enabled option — do NOT wrap (spec: stop at boundary).
function nextEnabled<T extends string | number>(
  options: SelectOption<T>[],
  current: number,
  delta: number,
): number {
  let i = current;
  for (;;) {
    const candidate = i + delta;
    if (candidate < 0 || candidate >= options.length) return i; // boundary: stay
    i = candidate;
    if (!options[i].disabled) return i;
  }
}

// Type-ahead match. Single-repeated-character buffer (e.g. "a", "aa") cycles
// among enabled options whose label starts with that character, advancing past
// `activeIndex`; any other buffer jumps to the first enabled prefix match.
// Returns -1 when nothing matches (caller keeps the current active option).
function matchTypeahead<T extends string | number>(
  options: SelectOption<T>[],
  buffer: string,
  activeIndex: number,
): number {
  const enabled = options
    .map((o, i) => ({ label: o.label.toLowerCase(), i, disabled: o.disabled }))
    .filter((x) => !x.disabled);
  const allSame = [...buffer].every((c) => c === buffer[0]);
  if (allSame) {
    const matches = enabled.filter((x) => x.label.startsWith(buffer[0]));
    if (matches.length === 0) return -1;
    return (matches.find((m) => m.i > activeIndex) ?? matches[0]).i;
  }
  const match = enabled.find((x) => x.label.startsWith(buffer));
  return match ? match.i : -1;
}
