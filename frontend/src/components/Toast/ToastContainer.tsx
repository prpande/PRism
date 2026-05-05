import { useToast } from './useToast';
import { Toast } from './Toast';

export function ToastContainer() {
  const { toasts, dismiss } = useToast();
  return (
    <div aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} onDismiss={dismiss} />
      ))}
    </div>
  );
}
