import { useEffect, useRef } from 'react';
import { isInputTarget } from './isInputTarget';

export interface FilesTabShortcutHandlers {
  onNextFile: () => void;
  onPrevFile: () => void;
  onToggleViewed: () => void;
  onToggleDiffMode: () => void;
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
