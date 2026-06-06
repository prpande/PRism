import { useEffect, useId, useRef, type ReactNode, type PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import styles from './SettingsModal.module.css';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface SettingsModalProps {
  onClose: () => void;
  children: ReactNode;
  // Spec §6: on close, focus returns to the opener. On a cold deep-link there is
  // no opener (body had focus), so focus moves to this background landmark
  // selector instead of being left on bare <body>.
  restoreFocusFallbackSelector?: string;
}

export function SettingsModal({
  onClose,
  children,
  restoreFocusFallbackSelector,
}: SettingsModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const scrimDownTarget = useRef<EventTarget | null>(null);
  const fallbackRef = useRef(restoreFocusFallbackSelector);
  fallbackRef.current = restoreFocusFallbackSelector;
  const titleId = useId();

  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    const target = dialog?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();
    return () => {
      // Trigger-opened → restore to the opener. Cold deep-link (body had focus)
      // → move to the background landmark, never bare <body> (spec §6).
      const opener = previouslyFocused.current;
      if (opener && opener !== document.body) opener.focus();
      else if (fallbackRef.current)
        document.querySelector<HTMLElement>(fallbackRef.current)?.focus();
    };
    // Run once on mount/unmount; the fallback selector is read via fallbackRef so
    // the empty dep array is intentional. (No exhaustive-deps suppression: the
    // react-hooks plugin is not wired into this project's flat eslint config, and
    // a stale disable directive for it errors as "rule not found".)
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const f = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
        if (f.length === 0) return;
        const first = f[0];
        const last = f[f.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialogRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !dialogRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  const onScrimPointerDown = (e: PointerEvent) => {
    scrimDownTarget.current = e.target;
  };
  const onScrimPointerUp = (e: PointerEvent) => {
    if (e.target === e.currentTarget && scrimDownTarget.current === e.currentTarget) onClose();
    scrimDownTarget.current = null;
  };

  return createPortal(
    <div
      className={styles.scrim}
      data-testid="settings-scrim"
      onPointerDown={onScrimPointerDown}
      onPointerUp={onScrimPointerUp}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={styles.modal}
      >
        <header className={styles.head}>
          <h2 id={titleId} className={styles.title}>
            Settings
          </h2>
          <button
            type="button"
            className={styles.close}
            aria-label="Close settings"
            onClick={onClose}
          >
            ✕
          </button>
        </header>
        {children}
      </div>
    </div>,
    document.body,
  );
}
