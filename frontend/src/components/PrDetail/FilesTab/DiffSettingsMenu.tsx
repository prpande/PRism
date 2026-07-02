// DiffSettingsMenu.tsx
import { useState, useRef, useId } from 'react';
import { useDismissableMenu } from '../../../hooks/useDismissableMenu';
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

  // Esc + outside-pointerdown dismissal (#328 shared hook). We do NOT auto-move
  // focus into the panel on open: a mouse user keeps their place and a keyboard
  // user tabs in (APG disclosure pattern). returnFocusOnOutsideClose is this
  // menu's pinned behavior: outside-click close refocuses the gear (deferred a
  // tick so it lands after the click sequence steals focus to body).
  useDismissableMenu({
    open,
    rootRef,
    returnFocusRef: triggerRef,
    onClose: () => setOpen(false),
    returnFocusOnOutsideClose: true,
  });

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
      data-testid="diff-settings-menu"
    >
      <button
        ref={triggerRef}
        type="button"
        className={`${styles.gear}${isModified ? ` ${styles.gearModified}` : ''}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={isModified ? 'Diff settings (modified)' : 'Diff settings'}
        title="Diff settings"
        onClick={() => setOpen((o) => !o)}
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
