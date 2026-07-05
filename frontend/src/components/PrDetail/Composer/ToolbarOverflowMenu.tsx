import { useEffect, useRef, useState } from 'react';
import type { FormatAction } from './markdownFormatting';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu';
import { ICONS, MoreIcon } from './formattingIcons';
import { TOOLBAR_BUTTONS, buttonTitle } from './toolbarButtons';

function defFor(action: FormatAction) {
  return TOOLBAR_BUTTONS.find((b) => b.action === action)!;
}

export interface ToolbarOverflowMenuProps {
  items: FormatAction[];
  runAction: (a: FormatAction) => void;
  disabled?: boolean;
  // Roving-tabindex participation: the "…" trigger is the toolbar's LAST stop, so
  // the parent supplies the trigger's tabIndex, a ref to register it in the
  // roving ref array, and a focus callback to sync the active index.
  tabIndex?: number;
  buttonRef?: (el: HTMLButtonElement | null) => void;
  onButtonFocus?: () => void;
}

export function ToolbarOverflowMenu({
  items,
  runAction,
  disabled = false,
  tabIndex,
  buttonRef,
  onButtonFocus,
}: ToolbarOverflowMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);

  // Shared dismissal (the same behavior every other popup menu uses —
  // DiffSettingsMenu, Select, …): document-level Escape returns focus to the
  // trigger; an outside pointerdown closes without moving focus. The Escape
  // focus-return is deferred a tick by the hook so it lands after the close.
  useDismissableMenu({
    open,
    rootRef,
    returnFocusRef: triggerRef,
    onClose: () => setOpen(false),
  });

  // If the composer becomes disabled (posting / cross-tab read-only) while the
  // menu is open, close it. The render is gated by `open && !disabled`, so a
  // stale `open=true` would otherwise (a) keep useDismissableMenu's document
  // listeners live behind a hidden menu and (b) pop the menu back open when
  // `disabled` clears (e.g. a post completes). Closing keeps state + ARIA honest.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) {
      setActiveIndex(0);
      // Focus the first item synchronously. The menu items are mounted by the
      // time this post-commit effect runs, so no requestAnimationFrame — rAF
      // would not fire under fake timers in tests that install them.
      itemRefs.current[0]?.focus();
    }
  }, [open]);

  // Escape + outside-click dismissal live in useDismissableMenu; this handler
  // owns only intra-menu arrow navigation.
  const onMenuKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const next = Math.min(items.length - 1, activeIndex + 1);
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      const next = Math.max(0, activeIndex - 1);
      setActiveIndex(next);
      itemRefs.current[next]?.focus();
    }
  };

  return (
    <div className="formatting-overflow" ref={rootRef}>
      <button
        ref={(el) => {
          triggerRef.current = el;
          buttonRef?.(el);
        }}
        type="button"
        className="formatting-toolbar-btn"
        aria-label="More formatting options"
        title="More formatting options"
        aria-haspopup="menu"
        aria-expanded={open}
        tabIndex={tabIndex}
        disabled={disabled}
        aria-disabled={disabled || undefined}
        onFocus={onButtonFocus}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <MoreIcon />
      </button>
      {open && !disabled && (
        <ul
          role="menu"
          aria-label="More formatting options"
          className="formatting-overflow-menu"
          onKeyDown={onMenuKeyDown}
        >
          {items.map((action, i) => {
            const def = defFor(action);
            const Icon = ICONS[action];
            return (
              <li key={action} role="none">
                <button
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitem"
                  tabIndex={i === activeIndex ? 0 : -1}
                  className="formatting-overflow-item"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    runAction(action);
                    setOpen(false);
                  }}
                >
                  <Icon />
                  <span>{buttonTitle(def)}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
