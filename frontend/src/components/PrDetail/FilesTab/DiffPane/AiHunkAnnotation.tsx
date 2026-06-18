import type { HunkAnnotation, AnnotationTone } from '../../../../api/types';
import { AiMarker } from '../../../Ai/AiMarker';
import { SampleBadge } from '../../../Ai/SampleBadge';
import styles from './AiHunkAnnotation.module.css';

export interface AiHunkAnnotationProps {
  annotation: HunkAnnotation;
}

// Tone → chip variant + label lookup. Adding a tone value here is the only
// touch required when the wire shape widens (e.g., a future v2 emits a new
// tone): map to the appropriate chip variant + handoff-aligned label.
const TONE_CHIP: Record<AnnotationTone, { variant: 'info' | 'warning' | 'danger'; label: string }> =
  {
    calm: { variant: 'info', label: 'Note' },
    'heads-up': { variant: 'warning', label: 'Behavior change' },
    concern: { variant: 'danger', label: 'Concern' },
  };

export function AiHunkAnnotation({ annotation }: AiHunkAnnotationProps) {
  // Nullish fallback so an unknown wire tone (e.g. a future v2 backend that
  // ships before the FE type is widened) renders as a neutral 'info' chip
  // labelled with the raw tone string, rather than `undefined`-derefing on
  // `chip.variant`. TypeScript exhaustiveness still flags new tones at
  // compile-time once FE types catch up.
  const chip = TONE_CHIP[annotation.tone] ?? { variant: 'info' as const, label: annotation.tone };
  return (
    <div className={`ai-hunk ${styles.aiHunk}`} data-testid="ai-hunk">
      <AiMarker variant="inline" decorative className="ai-icon" />
      <div className={styles.aiHunkBody}>
        <div className={`ai-hunk-meta ${styles.aiHunkMeta}`}>
          <span>AI</span>
          <SampleBadge solid />
          <span className={`chip chip-${chip.variant}`}>{chip.label}</span>
        </div>
        <div>{annotation.body}</div>
      </div>
    </div>
  );
}
