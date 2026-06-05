// DiffSettingsMenu.tsx
import { useState, useRef, useEffect, useId, useCallback } from 'react';
import { GearIcon } from './diffIcons';
import styles from './DiffSettingsMenu.module.css';

export interface DiffSettingsMenuProps {
  showFullFile: boolean;
  onShowFullFileChange: (on: boolean) => void;
  fullFileViewBlocked: boolean;
  fullFileViewBlockedReason: string | null;
  fullFileInertHere: boolean;
  fullFileInertReason: string | null;
  lineWrap: boolean;
  onLineWrapChange: (on: boolean) => void;
}

export function DiffSettingsMenu({
  showFullFile,
  onShowFullFileChange,
  fullFileViewBlocked,
  fullFileViewBlockedReason,
  fullFileInertHere,
  fullFileInertReason,
  lineWrap,
  onLineWrapChange,
}: DiffSettingsMenuProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const instanceId = useId();
  const panelId = `${instanceId}-diff-settings-panel`;
  const helperId = `${instanceId}-full-file-helper`;

  const close = useCallback(() => {
    setOpen(false);
    // Defer focus so it lands after any click-sequence that triggered close
    // (outside-click: pointerdown fires before mouseup/click steal focus to body).
    setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  // Outside-click close — net-new vs CommitMultiSelectPicker, which has none.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open, close]);

  // Escape from anywhere in the component (trigger OR panel) closes it. We do
  // NOT auto-move focus into the panel on open: a mouse user keeps their place
  // and a keyboard user tabs in. The APG disclosure pattern does not require
  // moving focus on open, and auto-focusing would jump the cursor for mouse
  // users. Putting onKeyDown on the root (which wraps the trigger) is what lets
  // Escape work whether focus is on the gear or on a panel control.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (open && e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };

  // Effective non-default state — a view-blocked full-file preference produces
  // no visible effect, so it must not light the indicator (spec: blocked/forced
  // states never count).
  const isModified = (showFullFile && !fullFileViewBlocked) || lineWrap;
  const helperText = fullFileViewBlocked
    ? fullFileViewBlockedReason
    : fullFileInertHere
      ? fullFileInertReason
      : null;

  return (
    <div
      ref={rootRef}
      className={`diff-settings-menu ${styles.root}`}
      onKeyDown={onKeyDown}
      data-testid="diff-settings-menu"
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.gear}${isModified ? ` ${styles.gearModified}` : ''}`}
        aria-haspopup="true"
        aria-expanded={open}
        aria-controls={panelId}
        aria-label={isModified ? 'Diff settings (modified)' : 'Diff settings'}
        title="Diff settings"
        onClick={() => (open ? close() : setOpen(true))}
        data-testid="diff-settings-trigger"
      >
        <GearIcon />
        {isModified && <span className={styles.modifiedDot} aria-hidden="true" />}
      </button>

      {open && (
        <div
          id={panelId}
          role="group"
          aria-label="Diff settings"
          className={styles.panel}
          data-testid="diff-settings-panel"
        >
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={showFullFile}
              disabled={fullFileViewBlocked}
              aria-describedby={helperText ? helperId : undefined}
              onChange={(e) => onShowFullFileChange(e.target.checked)}
              data-testid="show-full-file-checkbox"
            />
            <span>Show full file</span>
          </label>
          {helperText && (
            <p id={helperId} className={styles.helper} data-testid="show-full-file-helper">
              {helperText}
            </p>
          )}
          <label className={styles.row}>
            <input
              type="checkbox"
              checked={lineWrap}
              onChange={(e) => onLineWrapChange(e.target.checked)}
              data-testid="line-wrap-checkbox"
            />
            <span>Wrap long lines</span>
          </label>
        </div>
      )}
    </div>
  );
}
