import { useEffect, useRef, type PointerEvent, type RefObject } from 'react';

// Shared focusable-element selector for modal dialogs (#328) — the single copy
// of the string previously duplicated by Modal, SettingsModal, HelpModal and
// FeedbackModal.
export const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface ModalFocusTrapOptions {
  /** Trap only while open/visible. Listener lifetimes key on this. */
  active: boolean;
  /** Esc handler; omit to ignore Escape entirely (Modal's disableEscDismiss). */
  onEscape?: () => void;
  /**
   * When the captured opener is absent or was document.body, restore focus to
   * this selector's match instead. Omit to restore to the opener only.
   */
  restoreFallbackSelector?: string;
  /**
   * Consumer picks the element to focus on activation (e.g. Modal's
   * [data-modal-role], Feedback's first radio). Falling through (or returning
   * null) focuses the first FOCUSABLE_SELECTOR match inside the dialog.
   */
  initialFocus?: () => HTMLElement | null;
}

/**
 * Focus management for modal dialogs (#328): captures the previously-focused
 * element when `active` flips true, moves focus into the dialog, traps Tab at
 * both edges, routes Escape, and restores focus on deactivate/unmount.
 *
 * `onEscape` and `initialFocus` are read through a latest-ref so consumers may
 * pass fresh closures every render (FeedbackModal's `requestClose`) without
 * re-subscribing the document keydown listener.
 */
export function useModalFocusTrap(
  dialogRef: RefObject<HTMLElement | null>,
  opts: ModalFocusTrapOptions,
): void {
  const { active } = opts;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // Capture focus on activation; initial focus into the dialog; restore on
  // deactivate/unmount (opener first, else the fallback selector, else nothing).
  useEffect(() => {
    if (!active) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    if (dialog) {
      const target =
        optsRef.current.initialFocus?.() ?? dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      target?.focus();
    }
    return () => {
      if (previouslyFocused && previouslyFocused !== document.body) {
        previouslyFocused.focus();
        return;
      }
      const fallback = optsRef.current.restoreFallbackSelector;
      if (fallback) document.querySelector<HTMLElement>(fallback)?.focus();
    };
  }, [active, dialogRef]);

  // Esc + Tab focus trap. Listens at document level so the dialog catches
  // events even when focus is on internal controls (textarea, etc.).
  useEffect(() => {
    if (!active) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        const onEscape = optsRef.current.onEscape;
        if (onEscape) {
          e.preventDefault();
          onEscape();
        }
        return;
      }
      if (e.key === 'Tab' && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        const activeEl = document.activeElement;
        if (e.shiftKey && (activeEl === first || !dialogRef.current.contains(activeEl))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (activeEl === last || !dialogRef.current.contains(activeEl))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [active, dialogRef]);
}

/**
 * Scrim dismissal with the pointerdown/pointerup same-target guard (#328):
 * `onDismiss` fires only when both the pointer-down and pointer-up hit the
 * scrim element itself, so a drag that starts inside the dialog (e.g. a text
 * selection) and ends on the scrim does not close the modal.
 *
 * Plain per-render handlers over a ref — no document listeners, nothing to
 * unsubscribe; `onDismiss` may change identity freely.
 */
export function useScrimDismiss(onDismiss: () => void): {
  onPointerDown: (e: PointerEvent) => void;
  onPointerUp: (e: PointerEvent) => void;
} {
  const downTarget = useRef<EventTarget | null>(null);
  return {
    onPointerDown: (e: PointerEvent) => {
      downTarget.current = e.target;
    },
    onPointerUp: (e: PointerEvent) => {
      if (e.target === e.currentTarget && downTarget.current === e.currentTarget) onDismiss();
      downTarget.current = null;
    },
  };
}
