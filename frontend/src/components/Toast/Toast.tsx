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

export function Toast({ toast, onDismiss }: Props) {
  useEffect(() => {
    if (toast.kind === 'info') {
      const timer = setTimeout(() => onDismiss(toast.id), 5000);
      return () => clearTimeout(timer);
    }
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
