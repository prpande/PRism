import { useEffect, useRef, type RefObject } from 'react';

export interface DismissableMenuOptions {
  open: boolean;
  /** Outside-click boundary (trigger + popup). */
  rootRef: RefObject<HTMLElement | null>;
  /** The trigger button focus returns to. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Consumer state setter. */
  onClose: () => void;
}

/**
 * Shared dismissal behavior for lightweight popup menus (#328): document-level
 * Escape (no preventDefault) and outside pointerdown both close the menu.
 * Focus returns to `returnFocusRef` on Esc only; an outside click leaves focus
 * where the click landed (#705 unification — ARIA APG returns focus on Esc,
 * not on outside dismissal). The Esc focus return is deferred a tick
 * (setTimeout 0) so it lands after any event sequence that triggered the close.
 *
 * `onClose` is read through a latest-ref so consumers may pass fresh closures
 * every render without re-subscribing the document listeners.
 */
export function useDismissableMenu({
  open,
  rootRef,
  returnFocusRef,
  onClose,
}: DismissableMenuOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip an Escape another widget already consumed (a composer dirty-guard
      // or a modal trap preventDefaults it) — closing here would also schedule
      // a deferred refocus that can land behind a just-opened modal. The focus
      // return is deferred a tick so it lands after the closing event sequence.
      if (e.key === 'Escape' && !e.defaultPrevented) {
        onCloseRef.current();
        setTimeout(() => returnFocusRef.current?.focus(), 0);
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, rootRef, returnFocusRef]);
}
