import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalFocusTrap, useScrimDismiss } from '../../hooks/useModalFocusTrap';
import styles from './SettingsModal.module.css';

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
  const titleId = useId();

  // Focus capture/trap/restore + Esc (#328 shared hook). The modal is mounted
  // only while open, so `active: true` keys the trap to mount/unmount.
  // Restore semantics (spec §6): see restoreFallbackSelector on useModalFocusTrap.
  useModalFocusTrap(dialogRef, {
    active: true,
    onEscape: onClose,
    restoreFallbackSelector: restoreFocusFallbackSelector,
  });
  const scrim = useScrimDismiss(onClose);

  return createPortal(
    <div
      className={styles.scrim}
      data-testid="settings-scrim"
      onPointerDown={scrim.onPointerDown}
      onPointerUp={scrim.onPointerUp}
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
