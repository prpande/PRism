import { useIsSampleMode } from '../../hooks/useAiGate';
import styles from './SampleBadge.module.css';

export interface SampleBadgeProps {
  /** Solid fill (no dashed border) for placement inside an already-dashed container. */
  solid?: boolean;
}

// Truthful-by-default marker (spec §6). Renders ONLY in Preview; absent in Off
// (nothing renders) and Live (real output). Define-once: every AI surface that
// renders Preview/sample content mounts this beside its AI label.
export function SampleBadge({ solid = false }: SampleBadgeProps) {
  if (!useIsSampleMode()) return null;
  const cls = [styles.sampleBadge, solid ? styles.solid : ''].filter(Boolean).join(' ');
  return (
    <span
      className={cls}
      aria-label="Sample data — illustrative, not real AI output"
      data-sample-badge=""
      data-testid="sample-badge"
    >
      Sample
    </span>
  );
}
