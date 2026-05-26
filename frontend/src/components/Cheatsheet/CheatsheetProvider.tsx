import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
  type MutableRefObject,
} from 'react';

export interface CheatsheetApi {
  isOpen: boolean;
  toggle: () => void;
  close: () => void;
  // Captured at the open transition; the overlay restores focus here on close
  // with a liveness guard (per spec § 4.1).
  returnFocusRef: MutableRefObject<HTMLElement | null>;
}

// No-op default so components that call useCheatsheet() outside a provider
// (isolated tests, storyboard renders) still render. App.tsx mounts the real
// provider — mirrors useToast's NOOP_TOAST_API.
const NOOP_RETURN_FOCUS_REF: MutableRefObject<HTMLElement | null> = { current: null };
const NOOP_CHEATSHEET_API: CheatsheetApi = {
  isOpen: false,
  toggle: () => {},
  close: () => {},
  returnFocusRef: NOOP_RETURN_FOCUS_REF,
};

const CheatsheetContext = createContext<CheatsheetApi>(NOOP_CHEATSHEET_API);

export function CheatsheetProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const toggle = useCallback(() => {
    setIsOpen((prev) => {
      // Capture the focused element BEFORE state flips so it survives the
      // re-render. We only capture on the open transition; closing keeps the
      // ref so the close-side effect can read it.
      if (!prev) {
        const active = document.activeElement;
        returnFocusRef.current = active instanceof HTMLElement ? active : null;
      }
      return !prev;
    });
  }, []);
  const close = useCallback(() => setIsOpen(false), []);

  return createElement(
    CheatsheetContext.Provider,
    { value: { isOpen, toggle, close, returnFocusRef } },
    children,
  );
}

export function useCheatsheet(): CheatsheetApi {
  return useContext(CheatsheetContext);
}
