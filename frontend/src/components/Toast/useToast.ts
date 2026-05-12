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
  const show = useCallback((spec: Omit<ToastSpec, 'id'>) => {
    const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setToasts((prev) => [...prev, { id, ...spec }]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return createElement(ToastContext.Provider, { value: { toasts, show, dismiss } }, children);
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}
