import { useIsSampleMode } from '../../hooks/useAiGate';
import styles from './SampleBadge.module.css';

export interface SampleBadgeProps {
  /** 'inline' (default) sits beside an AI label; 'region' sits on a section header. */
  variant?: 'inline' | 'region';
  /** Solid fill (no dashed border) for placement inside an already-dashed container. */
  solid?: boolean;
}

// Truthful-by-default marker (spec §6). Renders ONLY in Preview; absent in Off
// (nothing renders) and Live (real output). Define-once: every AI surface that
// renders Preview/sample content mounts this beside its AI label or section header.
export function SampleBadge({ variant = 'inline', solid = false }: SampleBadgeProps) {
  if (!useIsSampleMode()) return null;
  const cls = [
    styles.sampleBadge,
    variant === 'region' ? styles.region : '',
    solid ? styles.solid : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span
      className={cls}
      aria-label="Sample data — illustrative, not real AI output"
      data-testid="sample-badge"
    >
      Sample
    </span>
  );
}
