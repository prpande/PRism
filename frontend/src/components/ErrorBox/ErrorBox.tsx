import type { ReactNode } from 'react';
import styles from './ErrorBox.module.css';

interface ErrorBoxProps {
  /** The error message — text or inline nodes. NOT action buttons. */
  children: ReactNode;
  /** Extra classes — preserves existing test/style hooks at the call site. */
  className?: string;
}

/**
 * Reusable, purely presentational error message. Renders a single
 * `role="alert"` element with a leading decorative danger glyph followed by the
 * message as direct content. No hooks, no context, no imports that can throw —
 * safe to render inside a crashed React error boundary. Action buttons live
 * outside this component, as siblings.
 */
export function ErrorBox({ children, className }: ErrorBoxProps) {
  const merged = className ? `${styles.errorBox} ${className}` : styles.errorBox;
  return (
    <div role="alert" className={merged}>
      <svg
        className={styles.icon}
        aria-hidden="true"
        viewBox="0 0 16 16"
        width={14}
        height={14}
        fill="currentColor"
      >
        <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm-.75 3.5a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-1.5 0v-4zM8 12.25A.875.875 0 1 1 8 10.5a.875.875 0 0 1 0 1.75z" />
      </svg>
      {children}
    </div>
  );
}
