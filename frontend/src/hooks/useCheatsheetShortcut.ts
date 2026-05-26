import { useEffect, useRef } from 'react';

// All HTMLInputElement.type values where keystrokes naturally insert a literal
// character. The spec frames the rule as "outside text inputs" — limiting this
// to type==='text' would miss password (PAT field on /setup), search, email,
// url, tel, and number, all of which a user can type ? into.
const TEXT_INPUT_TYPES = new Set(['text', 'password', 'search', 'email', 'url', 'tel', 'number']);

function isTextEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)) {
    return true;
  }
  // HTMLElement.isContentEditable walks ancestors and is true for any
  // element inside a truthy-contenteditable subtree (true / "" /
  // "plaintext-only") in real browsers. jsdom does NOT compute this from
  // the attribute, so the closest() probe is retained as a test-environment
  // fallback. Both paths converge on identical semantics in production.
  if (target.isContentEditable) return true;
  if (target.closest('[contenteditable]:not([contenteditable="false"])')) return true;
  if (target.closest('[data-composer="true"]')) return true;
  return false;
}

export function useCheatsheetShortcut(
  toggle: () => void,
  isOpen: boolean,
  close: () => void,
): void {
  // Capture the latest handlers AND isOpen flag in a ref so the document
  // listener is bound exactly once for the lifetime of the hook. Without
  // this, `[isOpen]` in the effect deps would churn the listener on every
  // toggle. Mirrors the useFilesTabShortcuts ref pattern.
  const stateRef = useRef({ toggle, close, isOpen });
  stateRef.current = { toggle, close, isOpen };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;
      const { toggle, close, isOpen } = stateRef.current;

      if (e.key === '?' && !isTextEditingContext(e.target)) {
        e.preventDefault();
        toggle();
        return;
      }
      if (isMeta && e.key === '/') {
        e.preventDefault();
        toggle();
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        // Capture-phase + stopPropagation ensures the composer's bubble-phase Esc
        // handler (discard-confirm) does not fire when the cheatsheet steals Esc.
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      }
      // Cmd/Ctrl+R intentionally NOT intercepted — the browser's reload runs.
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, []);
}
