import { useEffect, useRef } from 'react';

// All HTMLInputElement.type values where keystrokes naturally insert a literal
// character. The spec frames the rule as "outside text inputs" — limiting this
// to type==='text' would miss password (PAT field on /setup), search, email,
// url, tel, and number, all of which a user can type ? into.
const TEXT_INPUT_TYPES = new Set([
  'text',
  'password',
  'search',
  'email',
  'url',
  'tel',
  'number',
]);

function isTextEditingContext(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'TEXTAREA') return true;
  if (target.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((target as HTMLInputElement).type)) {
    return true;
  }
  if (target.closest('[contenteditable="true"]')) return true;
  if (target.closest('[data-composer="true"]')) return true;
  return false;
}

export function useCheatsheetShortcut(
  toggle: () => void,
  isOpen: boolean,
  close: () => void,
): void {
  // Capture latest handlers in a ref so we don't re-bind document listeners on every render
  // when callers pass freshly-created arrow functions. Mirrors useFilesTabShortcuts.
  const handlersRef = useRef({ toggle, close });
  handlersRef.current = { toggle, close };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const isMeta = e.metaKey || e.ctrlKey;

      if (e.key === '?' && !isTextEditingContext(e.target)) {
        e.preventDefault();
        handlersRef.current.toggle();
        return;
      }
      if (isMeta && e.key === '/') {
        e.preventDefault();
        handlersRef.current.toggle();
        return;
      }
      if (e.key === 'Escape' && isOpen) {
        // Capture-phase + stopPropagation ensures the composer's bubble-phase Esc
        // handler (discard-confirm) does not fire when the cheatsheet steals Esc.
        e.preventDefault();
        e.stopPropagation();
        handlersRef.current.close();
        return;
      }
      // Cmd/Ctrl+R intentionally NOT intercepted — the browser's reload runs.
    };

    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [isOpen]);
}
