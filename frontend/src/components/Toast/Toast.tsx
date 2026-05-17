import { useEffect } from 'react';
import styles from './Toast.module.css';

export interface ToastSpec {
  id: string;
  kind: 'info' | 'error';
  message: string;
  requestId?: string;
}

interface Props {
  toast: ToastSpec;
  onDismiss: (id: string) => void;
}

// Auto-dismiss windows by kind. Errors get a longer window than info because
// the message itself is longer (per-code copy from PrHeader's surfaceSubmitError
// is one full sentence) and the user is more likely to want to read it twice
// before it disappears. Both windows are deliberately bounded — pre-fix, errors
// stayed up forever; on a sticky drift that produced a wall of identical
// banners that never cleared even after the user fixed the underlying state.
const AUTO_DISMISS_MS: Record<ToastSpec['kind'], number> = {
  info: 5000,
  error: 10000,
};

export function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    const ms = AUTO_DISMISS_MS[toast.kind];
    if (ms === undefined) return;
    const timer = setTimeout(() => onDismiss(toast.id), ms);
    return () => clearTimeout(timer);
  }, [toast.id, toast.kind, onDismiss]);

  const copyDiagnostic = () => {
    if (toast.requestId) {
      void navigator.clipboard.writeText(toast.requestId);
    }
  };

  return (
    <div role="status" className={`${styles.toast} ${styles[toast.kind]}`}>
      <span>{toast.message}</span>
      {toast.requestId && (
        <button type="button" onClick={copyDiagnostic}>
          Copy diagnostic info
        </button>
      )}
      <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
