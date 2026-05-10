import { useEffect, useId, useRef } from 'react';

export interface ModalProps {
  open: boolean;
  title: string;
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
  children: React.ReactNode;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Modal({
  open,
  title,
  onClose,
  defaultFocus = 'primary',
  disableEscDismiss = false,
  children,
}: ModalProps) {
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // Initial focus on open + restore on close. Captures the prior active
  // element on the way in; restores focus to it on the way out.
  useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const target =
      dialog.querySelector<HTMLElement>(`[data-modal-role="${defaultFocus}"]`) ??
      dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    target?.focus();
    return () => {
      previouslyFocused.current?.focus();
    };
  }, [open, defaultFocus]);

  // Esc + Tab focus trap. Listens at document level so the dialog catches
  // events even when focus is on internal controls (textarea, etc.).
  useEffect(() => {
    if (!open) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !disableEscDismiss) {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const active = document.activeElement;
        if (e.shiftKey) {
          if (active === first || !dialogRef.current.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !dialogRef.current.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, onClose, disableEscDismiss]);

  if (!open) return null;

  return (
    <div className="modal-backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="modal-dialog"
      >
        <h2 id={titleId} className="modal-title">
          {title}
        </h2>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}
