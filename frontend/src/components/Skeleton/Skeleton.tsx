import type { CSSProperties } from 'react';
import styles from './Skeleton.module.css';

interface SkeletonProps {
  width?: number | string;
  height?: number | string;
  /** Border radius override; ignored when `circle` is set. */
  radius?: number | string;
  circle?: boolean;
  className?: string;
  'data-testid'?: string;
}

const DEFAULT_LINE_WIDTHS = ['100%', '92%', '96%', '85%', '90%', '70%'];

function toCss(v: number | string | undefined): string | undefined {
  if (v === undefined) return undefined;
  return typeof v === 'number' ? `${v}px` : v;
}

export function Skeleton({
  width,
  height,
  radius,
  circle,
  className,
  'data-testid': testId,
}: SkeletonProps) {
  const style: CSSProperties = {
    width: toCss(width),
    height: toCss(height),
    borderRadius: circle ? '50%' : toCss(radius),
  };
  return (
    <span
      className={className ? `${styles.block} ${className}` : styles.block}
      style={style}
      aria-hidden="true"
      data-testid={testId}
    />
  );
}

interface SkeletonTextProps {
  lines: number;
  /** Optional per-line widths; cycles if shorter than `lines`. */
  widths?: string[];
  className?: string;
  'data-testid'?: string;
}

export function SkeletonText({
  lines,
  widths,
  className,
  'data-testid': testId,
}: SkeletonTextProps) {
  const lineWidths = widths ?? DEFAULT_LINE_WIDTHS;
  return (
    <span className={className ? `${styles.text} ${className}` : styles.text} data-testid={testId}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={12} width={lineWidths[i % lineWidths.length]} />
      ))}
    </span>
  );
}
