import type { ReactNode } from 'react';
import styles from './Badge.module.css';

export interface BadgeProps {
  children: ReactNode;
  className?: string;
  'data-testid'?: string;
  'aria-label'?: string;
}

export function Badge({
  children,
  className,
  'data-testid': testId,
  'aria-label': ariaLabel,
}: BadgeProps) {
  return (
    <span
      className={`${styles.badge} ${className ?? ''}`.trim()}
      data-testid={testId}
      aria-label={ariaLabel}
    >
      {children}
    </span>
  );
}
