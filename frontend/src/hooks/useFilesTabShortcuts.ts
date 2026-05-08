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
  if (INPUT_TAG_NAMES.has(target.tagName)) return true;
  if (target.getAttribute('contenteditable') === 'true') return true;
  return false;
}

export function useFilesTabShortcuts(handlers: FilesTabShortcutHandlers): void {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isInputTarget(e.target)) return;

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
