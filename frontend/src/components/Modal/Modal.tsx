import { useId, useRef } from 'react';
import { useModalFocusTrap } from '../../hooks/useModalFocusTrap';

export interface ModalProps {
  open: boolean;
  title: string;
  /**
   * Optional decorative leading glyph for the title (e.g. an AI spark). Modal
   * wraps it in an aria-hidden span so it NEVER contributes to the dialog's
   * accessible name (aria-labelledby resolves to this <h2>). Callers do not
   * need to set aria-hidden themselves; pass a text-free decorative node.
   */
  titleIcon?: React.ReactNode;
  onClose: () => void;
  // 'primary' = default, focuses the destructive/affirmative button on open;
  // 'cancel' = focuses the dismissive button on open. Per spec § 5.5a, the
  // discard-saved-draft modal sets defaultFocus="cancel" so the user must
  // explicitly opt into destruction.
  defaultFocus?: 'primary' | 'cancel';
  // Per addendum A4: the 404-recovery modal MUST suppress Esc-to-dismiss
  // (the user must choose Re-create or Discard; otherwise the composer is
  // in an inconsistent state).
  disableEscDismiss?: boolean;
  // ARIA role for the dialog element. 'dialog' (default) for ordinary
  // dialogs; 'alertdialog' for urgent error dialogs that demand a response
  // (announced assertively by assistive tech on open). See #182.
  role?: 'dialog' | 'alertdialog';
  // Vertical placement of the card. 'top' (default) keeps the shared
  // top-anchored backdrop; 'center' vertically centers it via the
  // .modal-backdrop--center modifier. See #182.
  align?: 'top' | 'center';
  children: React.ReactNode;
}

export function Modal({
  open,
  title,
  titleIcon,
  onClose,
  defaultFocus = 'primary',
  disableEscDismiss = false,
  role = 'dialog',
  align = 'top',
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  // Focus capture/trap/restore + Esc routing (#328 shared hook). onClose fires
  // ONLY on Escape — no scrim click, no other dismissal path — and Esc is
  // suppressed entirely when disableEscDismiss is set (Tab stays trapped).
  useModalFocusTrap(dialogRef, {
    active: open,
    onEscape: disableEscDismiss ? undefined : onClose,
    initialFocus: () =>
      dialogRef.current?.querySelector<HTMLElement>(`[data-modal-role="${defaultFocus}"]`) ?? null,
  });

  if (!open) return null;

  return (
    <div className={`modal-backdrop${align === 'center' ? ' modal-backdrop--center' : ''}`}>
      <div
        ref={dialogRef}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-dialog"
      >
        <h2 id={titleId} className="modal-title">
          {titleIcon != null && <span aria-hidden="true">{titleIcon}</span>}
          {title}
        </h2>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
