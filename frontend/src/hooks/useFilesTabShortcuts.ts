import { useEffect, useRef } from 'react';

export interface FilesTabShortcutHandlers {
  onNextFile: () => void;
  onPrevFile: () => void;
  onToggleViewed: () => void;
  onToggleDiffMode: () => void;
}

const INPUT_TAG_NAMES = new Set(['TEXTAREA', 'INPUT', 'SELECT']);

function isInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  // ONLY the inline diff-view tiles (radios inside the .diff-view-toggle group)
  // may let the single-key Files-tab shortcuts (j/k/v/d) through. Scoped to that
  // specific class — not any [role="radiogroup"] — so a future radiogroup
  // elsewhere on the page (e.g. a modal form) cannot inadvertently leak shortcuts.
  // Everything else — text fields AND the gear's checkboxes — still suppresses, so
  // typing inside the open settings menu never navigates files / toggles mode.
  if (
    target.tagName === 'INPUT' &&
    (target as HTMLInputElement).type === 'radio' &&
    target.closest('.diff-view-toggle')
  ) {
    return false;
  }
  if (INPUT_TAG_NAMES.has(target.tagName)) return true; // TEXTAREA, INPUT (incl. checkbox), SELECT
  if (target.closest('[contenteditable="true"]')) return true;
  return false;
}

export function useFilesTabShortcuts(handlers: FilesTabShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputTarget(e.target)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case 'j':
          handlersRef.current.onNextFile();
          break;
        case 'k':
          handlersRef.current.onPrevFile();
          break;
        case 'v':
          handlersRef.current.onToggleViewed();
          break;
        case 'd':
          handlersRef.current.onToggleDiffMode();
          break;
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, []);
}
