import { useEffect, useRef, type RefObject } from 'react';

export interface DismissableMenuOptions {
  open: boolean;
  /** Outside-click boundary (trigger + popup). */
  rootRef: RefObject<HTMLElement | null>;
  /** The trigger button focus returns to. */
  returnFocusRef: RefObject<HTMLElement | null>;
  /** Consumer state setter. */
  onClose: () => void;
  /**
   * Also return focus to the trigger on close-by-outside-click (DiffSettingsMenu
   * pins this). Default false: the other menus leave focus where the click put it.
   */
  returnFocusOnOutsideClose?: boolean;
}

/**
 * Shared dismissal behavior for lightweight popup menus (#328): document-level
 * Escape (no preventDefault) and outside pointerdown both close the menu.
 * Focus returns to `returnFocusRef` on Esc always, and on outside-click only
 * when `returnFocusOnOutsideClose` is set. The focus return is deferred a tick
 * (setTimeout 0) so it lands after any click sequence that triggered the close
 * (outside-click: pointerdown fires before mouseup/click steal focus to body).
 *
 * `onClose` is read through a latest-ref so consumers may pass fresh closures
 * every render without re-subscribing the document listeners.
 */
export function useDismissableMenu({
  open,
  rootRef,
  returnFocusRef,
  onClose,
  returnFocusOnOutsideClose = false,
}: DismissableMenuOptions): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    const close = (returnFocus: boolean) => {
      onCloseRef.current();
      if (returnFocus) setTimeout(() => returnFocusRef.current?.focus(), 0);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      // Skip an Escape another widget already consumed (a composer dirty-guard
      // or a modal trap preventDefaults it) — closing here would also schedule
      // a deferred refocus that can land behind a just-opened modal.
      if (e.key === 'Escape' && !e.defaultPrevented) close(true);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        close(returnFocusOnOutsideClose);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [open, rootRef, returnFocusRef, returnFocusOnOutsideClose]);
}
