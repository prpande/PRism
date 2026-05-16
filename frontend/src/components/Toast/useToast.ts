import {
  createContext,
  useContext,
  useState,
  useCallback,
  type ReactNode,
  createElement,
} from 'react';
import type { ToastSpec } from './Toast';

interface ToastApi {
  toasts: ToastSpec[];
  show: (spec: Omit<ToastSpec, 'id'>) => void;
  dismiss: (id: string) => void;
}

// No-op default so components that call useToast() render fine outside a
// ToastProvider (tests, isolated renders) — mirrors useEventSource() returning
// null and being handled gracefully. App.tsx mounts the real provider.
const NOOP_TOAST_API: ToastApi = {
  toasts: [],
  show: () => {},
  dismiss: () => {},
};

const ToastContext = createContext<ToastApi>(NOOP_TOAST_API);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastSpec[]>([]);
  // De-dup: skip a new toast whose (kind, message) matches one already on
  // screen. Spam-clicking Submit while a sticky drift causes back-to-back
  // identical errors otherwise stacks the same banner N times. Identity is
  // (kind, message); requestId differences are ignored for de-dup so the
  // already-visible toast keeps its first request id (more useful than the
  // latest, which is a clone of the same root cause).
  const show = useCallback((spec: Omit<ToastSpec, 'id'>) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => {
      if (prev.some((t) => t.kind === spec.kind && t.message === spec.message)) {
        return prev;
      }
      return [...prev, { id, ...spec }];
    });
  }, []);
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return createElement(ToastContext.Provider, { value: { toasts, show, dismiss } }, children);
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
