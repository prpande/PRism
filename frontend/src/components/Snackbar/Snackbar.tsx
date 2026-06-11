import type { ReactNode } from 'react';
import styles from './Snackbar.module.css';

export interface SnackbarProps {
  tone: 'warning' | 'danger';
  message: ReactNode;
  action?: { label: string; onClick: () => void };
  // Optional: omit when the consumer announces via its own always-mounted live
  // region (GitHubAuthBanner does this — Task 11) so the visible bar isn't a
  // second live region that double-announces.
  onDismiss?: () => void;
  role?: 'status' | 'alert';
  ariaLive?: 'polite' | 'assertive';
}

export function Snackbar({ tone, message, action, onDismiss, role, ariaLive }: SnackbarProps) {
  return (
    <div
      className={`${styles.snackbar} ${styles[tone]}`}
      role={role}
      aria-live={ariaLive}
      aria-atomic={ariaLive ? 'true' : undefined}
    >
      <span className={styles.message}>{message}</span>
      {action && (
        <button type="button" className={styles.action} onClick={action.onClick}>
          {action.label}
        </button>
      )}
      {onDismiss && (
        <button type="button" className={styles.dismiss} aria-label="Dismiss" onClick={onDismiss}>
          ×
        </button>
      )}
    </div>
  );
}
